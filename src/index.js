import * as TowerCGServer from '@towercg/server';

import * as _ from 'lodash';
import * as fs from 'fs-extra';
import * as path from 'path';
import Loki from 'lokijs';
import { promisify } from 'util';
import TwitchAPI from 'twitch-api-v5';
import TwitchHelix from 'twitch-helix';
import BloomFilter from 'bloom-filter';
import { client as TMIClient } from 'tmi.js';
import * as TwitchBetterAPI from '@eropple/twitch-better-api';

import { pluginReducer } from './reducer';

import TwitchHttp from './http';

export const twitchScopes =
  "channel_read channel_editor channel_commercial channel_subscriptions chat_login channel_feed_read channel_feed_edit";

const twitchUpdateChannel = promisify(TwitchAPI.channels.updateChannel);
const twitchRunCommercial = promisify(TwitchAPI.channels.startAd);
const twitchSearchGames = promisify(TwitchAPI.search.games);

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
    chatDebug: false,
    polling: {
      followerInterval: 2000,
      channelInterval: 2000
    },
    bloom: {
      size: 1000000,
      chance: 0.0005
    },
    connection: {
      reconnect: true,
      connectText: "TowerCG connected."
    },
    identity: {},
    gameDatabase: {
      ttl: 86400,
      desiredBoxartHeightPx: 720
    },
    debounce: true
  };

  async initialize() {
    const {identity} = this.pluginConfig;
    this._channels = this.pluginConfig.channels || [`#${identity.username}`];

    this._channelIds = {};
    this._followerFilters = {};

    this._ensureDirectories();
    this.db = this._initLoki();

    this._registerCommands();
    this._twitch = await this._configureTwitchApi();
    this._channelIds = await this._fetchChannelIds();
    (this._channelIds)

    this._twitchIRC = await this._configureTwitchIRC();
    this._twitchIRC.connect();

    console.log(TwitchHttp)
    this.registerHttpHandlers = TwitchHttp.bind(this);
  }

  get twitch() { return this._twitch; }
  get connected() { return this._connected; }
  get channels() { return this._channels; }
  get channelIds() { return this._channelIds; }

  get oauthClientId() { return this.pluginConfig.identity.oauthClientId; }
  get oauthToken() { return this.pluginConfig.identity.oauthToken; }

  _initLoki() {
    const loki = new Loki(this.computeStoragePath("db.json"), {
      autosave: true,
      autosaveInterval: 0,
      autoload: true
    });

    ["games"].forEach((collectionName) => {
      loki.getCollection(collectionName) || loki.addCollection(collectionName);
    });

    return loki;
  }

  _ensureDirectories() {
    for (let channel of this.channels) {
      fs.mkdirsSync(this.computeStoragePath(`${channel}`));
    }

    fs.mkdirsSync(this.computeCachePath("games"));
    fs.mkdirsSync(this.computeCachePath("boxart"));
  }

  _registerCommands() {
    this.registerCommand("runCommercial", async (payload) => {
      const {channel, duration} = payload;

      const channelID = this._channelIds[channel];
      await twitchRunCommercial({ channelID, duration });

      return { ok: true };
    });

    this.registerCommand("updateChannel", async (payload) => {
      const {channel, options} = payload;

      const request = _.merge({}, options, {
        auth: this.oauthToken,
        channelID: this._channelIds[channel]
      });
      const result = await twitchUpdateChannel(request);
      if (result.error) {
        throw new Error(result.error);
      }

      await this._fetchChannelInfo(channel);

      return result;
    });
  }

  async _configureTwitchApi() {
    const {apiDebug, identity} = this.pluginConfig;
    TwitchAPI.clientID = this.oauthClientId;
    TwitchAPI.debug = apiDebug;

    try {
      const twitchApi = TwitchBetterAPI.connectWithUserAccessToken(
        this.oauthToken, this.logger, {}
      );

      return twitchApi;
    } catch (err) {
      this.logger.error({ err }, "Error in configuring Twitch API.");
      throw err;
    }
  }

  async _configureTwitchIRC() {
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

    this.logger.info(`Setting up Twitch connector; username ${identity.username}, channels ${this.channels}.`);

    const twitchIRC = new TMIClient(config);
    await this._configureTwitchEvents(twitchIRC);
    await this._configureSelfEvents();

    return twitchIRC;
  }

  async _fetchChannelIds() {
    const users = this.channels.map((channel) => channel.replace("#", ""));
    const result = await this.twitch.users.getUsersByLogin(users);

    const ret = {};

    Object.values(result).forEach((user) => {
      const channelName = `#${user.login}`;
      ret[channelName] = user.id;
    })

    return ret;
  }

  async _configureTwitchEvents(twitchIRC) {
    const {pluginConfig} = this;

    twitchIRC.on('logon', () => {
      this.logger.info("Logged into Twitch IRC.");
    });

    twitchIRC.on('connected', () => {
      this.logger.info("Connected to Twitch IRC.");
      this._connected = true;
      this.emit('connected');
    });

    twitchIRC.on('disconnected', () => {
      this._connected = false;
      this.emit('disconnected');
    });

    twitchIRC.on('roomstate', (channel, state) => {
      this.logger.info(`Joined room ${channel}.`);
      twitchIRC.say(channel, pluginConfig.connection.connectText);

      this._startChannelPoller(channel);
      this._startFollowPoller(channel);

      this.emit('roomstate', { channel, state });
    });

    ['chat', 'action', 'whisper', 'message'].forEach((eventName) => {
      twitchIRC.on(eventName, (channel, userstate, message, self) => {
        const displayName = userstate['display-name'];

        pluginConfig.debugMessages &&
          this.logger.debug(`[${channel}] ${displayName} ${eventName}: ${message}`);
        this.emit(eventName, { channel, userstate, displayName, message, self });
      });
    });

    twitchIRC.on("hosted", (channel, username, viewers) => {
      pluginConfig.logHosts &&
        this.logger.info(`Hosted: ${channel} now hosted by ${username} (${viewers} viewers).`);
      this.emit("hosted", { channel, username, viewers });
    });

    twitchIRC.on("subscription", (channel, username, method, message, userstate) => {
      pluginConfig.logSubscriptions &&
        this.logger.info(`Subscribed: ${channel} subscribed to by ${username}.`);
      this.emit("subscription", { channel, username, displayName: userstate['display-name'], message, userstate, method });
    });

    twitchIRC.on("resub", (channel, username, months, message, userstate, methods) => {
      pluginConfig.logSubscriptions &&
        this.logger.info(`Resubscribed: ${channel} subscribed to by ${username} (${months} months).`);
      this.emit("resub", { channel, username, displayName: userstate['display-name'], months, message, userstate, methods });
    });

    twitchIRC.on("cheer", (channel, userstate, message) => {
      pluginConfig.logCheers &&
        this.logger.info(`Cheer received on ${channel}, ${userstate.bits} bits.`);

      server.emit("cheer", { channel, userstate, displayName: userstate['display-name'], bits: userstate.bits, message });
    });
  }

  async _configureSelfEvents() {
    const {pluginConfig} = this;

    this.on('stateChanged', ({oldState, newState}) => {
      for (let channel of this.channels) {
        const oldStatus = _.get(oldState, ["channels", channel, "status"]);
        const newStatus = _.get(newState, ["channels", channel, "status"]);

        if (oldStatus !== newStatus) {
          this.logger.info(`[${channel}]: status changed to '${newStatus}'.`);
          this.emit("statusChanged", { oldStatus, newStatus });
        }

        const oldGame = _.get(oldState, ["channels", channel, "game"]);
        const newGame = _.get(newState, ["channels", channel, "game"]);

        if (oldGame !== newGame) {
          this.logger.info(`[${channel}]: game changed to '${newGame}'.`);
          this.emit("gameChanged", { oldGame, newGame });
        }
      }
    });

    this.on('newFollower', (event) => {
      const {user, channel} = event;

      pluginConfig.logFollows &&
        this.logger.info(`[${channel}] New follower ${user.login} (${user.id})`);
    });
  }

  async _startChannelPoller(channel) {
    setInterval(
      async () => this._fetchChannelInfo(channel),
      this.pluginConfig.polling.channelInterval
    );
  }

  async _startFollowPoller(channel) {
    const channelId = this._channelIds[channel];
    if (!channelId) {
      throw new Error(`Couldn't get channel ID for ${channel}.`);
    }

    this.logger.debug(`Setting up follow polling for ${channel}.`);

    this.logger.debug(`Configuring follower polling for ${channel}.`);

    await this._loadBloomFilter(channel);

    setInterval(
      async () => this._pollFollowers(channel, channelId),
      this.pluginConfig.polling.followerInterval
    );
  }

  async _loadBloomFilter(channel) {
    const pluginConfig = this.pluginConfig;
    const filePath = this.computeStoragePath(`${channel}/followers.json`);
    if (await fs.exists(filePath)) {
      this._followerFilters[channel] = new BloomFilter(await fs.readJson(filePath));
    } else {
      this._followerFilters[channel] =
        BloomFilter.create(pluginConfig.bloom.size, pluginConfig.bloom.chance);
    }

    this._saveBloomFilter(channel);
  }

  async _saveBloomFilter(channel) {
    const filter =
      this._followerFilters[channel] ||
      BloomFilter.create(pluginConfig.bloom.size, pluginConfig.bloom.chance);
    const filePath = this.computeStoragePath(`${channel}/followers.json`);
    return fs.writeJson(filePath, filter.toObject());
  }

  async _pollFollowers(channel, channelId) {
    try {
      const cursor = this.twitch.users.getUserFollowersCursor(channelId);
      let data = await cursor.next();

      const followIds = data.map((f) => f.from_id);
      const followers = Object.values(await this.twitch.users.getUsersById(followIds));

      return Promise.all(
        followers.map((follow) => this._processFollower(channel, follow))
      );
    } catch (err) {
      this.logger.error({ err }, "Error polling followers.")
      throw err;
    }
  }

  async _processFollower(channel, user) {
    const filter = this._followerFilters[channel];

    if (filter.contains(user.id)) {
      this.logger.trace(`[${channel}] Old follower ${user.login} (${user.id})`);
    } else {
      filter.insert(user.id);
      await this._saveBloomFilter(channel);

      this.emit('newFollower', { channel, user });
    }
  }

  async _fetchChannelInfo(channel) {
    const channelID = this._channelIds[channel];
    const channelInfo = await this.twitch.channels.getChannelById(channelID);
    channelInfo.gameInfo = await this._fetchGameInfo(channelInfo.game);

    this.dispatch({
      type: "twitch.setChannelInfo",
      key: channel,
      payload: channelInfo
    });

    return channelInfo;
  }

  async _fetchGameInfo(gameName) {
    return this.cache.json(`games/${gameName}`, async () => {
      const games = await this.twitch.games.getGamesByName(gameName);
      return games[gameName];
    })
  }
}
