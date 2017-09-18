import * as TowerCGServer from '@towercg/server';

import { pluginReducer } from './reducer';

export class TwitchPlugin extends TowerCGServer.ServerPlugin {
  static pluginName = "twitch";
  static reducer = pluginReducer;
  static defaultConfig = {};

  initialize() {
    const {username, chatPassword, oauthClientId, oauthToken} = this.pluginConfig;

    this.logger.info(`Initializing for Twitch user '${username}'.`);
  }
}
