import { combineReducers } from 'redux';

import * as TowerCGServer from '@towercg/server';

export const pluginReducer = combineReducers({
  channels: TowerCGServer.ReducerHelpers.keyedSetter("twitch.setChannelInfo", "twitch.resetChannels")
});
