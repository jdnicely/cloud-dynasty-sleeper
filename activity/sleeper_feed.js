(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SleeperFeed = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ENDPOINT = 'https://sleeper.com/graphql';

  function makeError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function buildMessagesQuery(leagueId, before = null) {
    const parent = JSON.stringify(String(leagueId));
    const beforeArg = before == null ? '' : `, before: ${JSON.stringify(String(before))}`;
    return `query messages {
      latest: messages(parent_id: ${parent}${beforeArg}) {
        attachment author_avatar author_display_name author_real_name author_id
        author_is_bot author_role_id created edited message_id parent_id parent_type
        pinned reactions user_reactions text text_map
      }
    }`;
  }

  async function requestPage({leagueId, token, before = null, fetchImpl}) {
    const query = buildMessagesQuery(leagueId, before);
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: token,
        },
        body: JSON.stringify({operationName: 'messages', variables: {}, query}),
      });
    } catch (_) {
      throw makeError('Sleeper feed request was blocked or could not connect.', 'NETWORK_OR_CORS');
    }
    if (response.status === 401 || response.status === 403) {
      throw makeError('Sleeper feed token was rejected.', 'UNAUTHORIZED');
    }
    if (!response.ok) {
      throw makeError(`Sleeper feed returned HTTP ${response.status}.`, 'HTTP');
    }
    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      const text = JSON.stringify(payload.errors).toLowerCase();
      if (text.includes('auth') || text.includes('unauthorized')) {
        throw makeError('Sleeper feed token was rejected.', 'UNAUTHORIZED');
      }
      throw makeError('Sleeper feed schema/query failed.', 'GRAPHQL');
    }
    if (!Array.isArray(payload?.data?.latest)) {
      throw makeError('Sleeper feed response did not contain a message list.', 'SCHEMA');
    }
    return payload.data.latest;
  }

  async function fetchMessages({leagueId, token, sinceMs = null, fetchImpl = fetch, maxPages = 20}) {
    if (!token) throw makeError('Sleeper feed is not connected.', 'NO_TOKEN');

    const all = [];
    const seen = new Set();
    let before = null;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await requestPage({leagueId, token, before, fetchImpl});
      if (!page.length) break;

      let added = 0;
      for (const message of page) {
        const id = String(message?.message_id || '');
        const key = id || `${message?.created || 0}:${all.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(message);
        added += 1;
      }
      if (!added) break;
      if (sinceMs == null) break;

      const times = page.map(message => Number(message?.created || 0)).filter(Number.isFinite);
      const oldestTime = times.length ? Math.min(...times) : 0;
      if (oldestTime <= Number(sinceMs)) break;

      const oldest = page.reduce((best, message) => {
        if (!best) return message;
        return Number(message?.created || 0) < Number(best?.created || 0) ? message : best;
      }, null);
      const nextBefore = oldest?.message_id == null ? null : String(oldest.message_id);
      if (!nextBefore || nextBefore === before) break;
      before = nextBefore;
    }

    return all;
  }

  function isUnauthorized(error) {
    return error?.code === 'UNAUTHORIZED';
  }

  return {ENDPOINT, buildMessagesQuery, fetchMessages, isUnauthorized};
});
