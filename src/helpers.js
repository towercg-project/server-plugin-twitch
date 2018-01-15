import * as _ from 'lodash';
import * as querystring from 'querystring';

export async function fetchGameById(id_or_ids, useCache = true) {
  const ids = _.flatten([id_or_ids]);
  const collection = this.db.getCollection("games");

  if (useCache && ids.length === 1) {
    // TODO: implement cache
  }

  const query = querystring.stringify({ id: ids });
  const response = await this._twitchHelix.sendHelixRequest(`games?${query}`);

  console.log(response);
  return response;
}

export async function fetchGameByName(name_or_names, useCache = true) {
  const names = _.flatten([name_or_names]);

  const collection = this.db.getCollection("games");

  if (useCache && names.length === 1) {
    // TODO: implement cache
  }

  const query = querystring.stringify({ name: names });
  const response = await this._twitchHelix.sendHelixRequest(`games?${query}`);

  console.log(response);
  return response;
}
