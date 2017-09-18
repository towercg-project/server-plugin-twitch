import * as TowerCGServer from '@towercg/server';

import * as _ from 'lodash';
import * as fs from 'fs-extra';
import * as path from 'path';
import { promisify } from 'util';
import TwitchAPI from 'twitch-api-v5';
import BloomFilter from 'bloom-filter';
import { client as TMIClient } from 'tmi.js';

import { pluginReducer } from './reducer';

export const twitchScopes =
  "channel_read channel_editor channel_commercial " +
  "channel_subscriptions chat_login channel_feed_read channel_feed_edit";

const twitchUsersByName = promisify(TwitchAPI.users.usersByName);
const twitchFollowersForChannel = promisify(TwitchAPI.channels.followers);

export class TwitchPlugin extends TowerCGServer.ServerPlugin {
  static pluginName = "twitch";
  static reducer = pluginReducer;
  static defaultConfig = {
    debugMessages: false,
    logHosts: true,
    logFollows: true,
    logSubscriptions: true,
    logCheers: true,
    apiDebug: false,
    followerPolling: {
      interval: 2000
    },
    connection: {
      reconnect: true,
      connectText: "TowerCG connected."
    },
    identity: {},
    debounce: true
  };

  async initialize() {
    const {identity} = this.pluginConfig;
    this._channels = this.pluginConfig.channels || [`#${identity.username}`];

    for (let channel of this.channels) {
      fs.mkdirsSync(this.computeStoragePath(`twitch/${channel}`));
    }

    this._channelIds = {};
    this._followerFilters = {};

    await this._configureTwitchApi();
    this._twitchEvents = await this._configureTmi();
  }

  get connected() { return this._connected; }
  get channels() { return this._channels; }
  get channelIds() { return this._channelIds; }

  async _configureTwitchApi() {
    const {identity} = this.pluginConfig;
    TwitchAPI.clientID = identity.oauthClientId;

    this._channelIds = await this._fetchChannelIds(this.channels);
  }

  async _configureTmi() {
    const {apiDebug, identity, connection} = this.pluginConfig;

    const config = {
      options: {
        clientId: identity.oauthClientId,
        debug: apiDebug
      },
      channels: this.channels,
      connection,
      identity: _.merge({}, identity, { password: identity.chatPassword }),
      logger: apiDebug ? this.logger.child({ api: "twitch" }) : undefined
    };

    this.logger.debug(`Setting up Twitch connector; username ${identity.username}, channels ${this.channels}.`);

    const twitch = new TMIClient(config);
    await this._configureTwitchEvents(twitch);
    await this._configureSelfEvents();

    twitch.connect();
    return twitch;
  }

  async _fetchChannelIds(channels) {
    const users = channels.map((channel) => channel.replace("#", ""));
    const result = await twitchUsersByName({ users });

    const ret = {};

    result.users.forEach((user) => {
      const channelName = `#${user.name}`;
      ret[channelName] = user._id;
    })

    return ret;
  }

  async _configureTwitchEvents(twitch) {
    const {pluginConfig} = this;

    twitch.on('logon', () => {
      this.logger.info("Logged into Twitch.");
    });

    twitch.on('connected', () => {
      this.logger.info("Connected to Twitch.");
      this._connected = true;
      this.emit('connected');
    });

    twitch.on('disconnected', () => {
      this._connected = false;
      this.emit('disconnected');
    });

    twitch.on('roomstate', (channel, state) => {
      this.logger.debug(`Joined room ${channel}.`);
      twitch.say(channel, pluginConfig.connection.connectText);

      this._configureFollowPoller(twitch, channel);

      this.emit('roomstate', { channel, state });
    });

    ['chat', 'action', 'whisper', 'message'].forEach((eventName) => {
      twitch.on(eventName, (channel, userstate, message, self) => {
        const displayName = userstate['display-name'];

        pluginConfig.debugMessages &&
          this.logger.debug(`[${channel}] ${displayName} ${eventName}: ${message}`);
        this.emit(eventName, { channel, userstate, displayName, message, self });
      });
    });

    twitch.on("hosted", (channel, username, viewers) => {
      pluginConfig.logHosts &&
        this.logger.info(`Hosted: ${channel} now hosted by ${username} (${viewers} viewers).`);
      this.emit("hosted", { channel, username, viewers });
    });

    twitch.on("resub", (channel, username, months, message, userstate, methods) => {
      pluginConfig.logSubscriptions &&
        this.logger.info(`Subscribed: ${channel} subscribed to by ${username} (${months} months).`);
      this.emit("resub", { channel, username, displayName: userstate['display-name'], months, message, userstate, methods });
    });

    twitch.on("cheer", (channel, userstate, message) => {
      pluginConfig.logCheers &&
        this.logger.info(`Cheer received on ${channel}, ${userstate.bits} bits.`);

      server.emit("cheer", { channel, userstate, displayName: userstate['display-name'], bits: userstate.bits, message });
    });
  }

  async _configureSelfEvents() {
    const {pluginConfig} = this;

    this.on('newFollower', (event) => {
      const {user, channel} = event;

      pluginConfig.logFollows &&
        this.logger.info(`[${channel}] New follower ${user.name} (${user._id})`);
    });
  }

  async _configureFollowPoller(twitch, channel) {
    const channelId = this._channelIds[channel];
    if (!channelId) {
      throw new Error(`Couldn't get channel ID for ${channel}.`);
    }

    this.logger.debug(`Setting up follow polling for ${channel}.`);

    const {followerPolling} = this.pluginConfig;
    this.logger.debug(`Configuring follower polling for ${channel}.`);

    await this._loadBloomFilter(channel);

    setInterval(
      async () => this._pollFollowers(channel, channelId),
      followerPolling.interval
    );
  }

  async _loadBloomFilter(channel) {
    const filePath = this.computeStoragePath(`twitch/${channel}/followers.json`);
    if (await fs.exists(filePath)) {
      this._followerFilters[channel] = new BloomFilter(await fs.readJson(filePath));
    } else {
      this._followerFilters[channel] = BloomFilter.create(50000, 0.005);
    }

    this._saveBloomFilter(channel);
  }

  async _saveBloomFilter(channel) {
    const filter = this._followerFilters[channel] || BloomFilter.create(50000, 0.005);
    const filePath = this.computeStoragePath(`twitch/${channel}/followers.json`);
    return fs.writeJson(filePath, filter.toObject());
  }

  async _pollFollowers(channel, channelId) {
    const result = await twitchFollowersForChannel({ channelID: channelId });
    const follows = result.follows;

    await Promise.all(
      follows.map((follow) => this._processFollower(channel, follow.user))
    );
  }

  async _processFollower(channel, user) {
    const filter = this._followerFilters[channel];

    if (filter.contains(user._id)) {
      this.logger.trace(`[${channel}] Old follower ${user.name} (${user._id})`);
    } else {
      filter.insert(user._id);
      await this._saveBloomFilter(channel);

      this.emit('newFollower', { channel, user });
    }
  }
}
