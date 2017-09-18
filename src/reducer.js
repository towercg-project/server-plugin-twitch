import { combineReducers } from 'redux';

import { ReducerHelpers as RH } from '@towercg/server';

export const pluginReducer = combineReducers({
  channels: RH.keyedSetter("twitch.setChannelInfo", "twitch.resetChannels")
});
