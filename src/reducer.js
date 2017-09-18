import { combineReducers } from 'redux';

function tickReducer(state = 1 , action) {
  switch (action.type) {
    case "example.incrementTicks":
      return state + 1;
    default:
      return state;
  }
}

export const pluginReducer = combineReducers({
  ticks: tickReducer
});
