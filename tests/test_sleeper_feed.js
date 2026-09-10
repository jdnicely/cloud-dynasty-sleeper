const assert = require('assert');
const feed = require('../activity/sleeper_feed.js');

(async () => {
  let captured = null;
  const fakeFetch = async (url, options) => {
    captured = {url, options};
    return {
      ok: true,
      status: 200,
      json: async () => ({data: {latest: [{message_id: 'm1', created: 1, text: 'hello'}]}}),
    };
  };
  const messages = await feed.fetchMessages({
    leagueId: '1389332241724764160',
    token: 'super-secret-token',
    fetchImpl: fakeFetch,
  });
  assert.equal(messages.length, 1);
  assert.equal(captured.url, 'https://sleeper.com/graphql');
  assert.equal(captured.options.headers.authorization, 'super-secret-token');
  assert.ok(!captured.options.body.includes('super-secret-token'));
  assert.ok(captured.options.body.includes('messages(parent_id'));
  assert.ok(!captured.options.body.toLowerCase().includes('mutation'));

  await assert.rejects(
    () => feed.fetchMessages({
      leagueId: '1389332241724764160',
      token: 'bad',
      fetchImpl: async () => ({ok: false, status: 401, text: async () => 'Unauthorized'}),
    }),
    error => error.code === 'UNAUTHORIZED',
  );

  let pageCall = 0;
  const pagedFetch = async (url, options) => {
    pageCall += 1;
    const body = JSON.parse(options.body);
    if (pageCall === 1) {
      assert.ok(!body.query.includes('before:'));
      return {
        ok: true, status: 200,
        json: async () => ({data: {latest: [
          {message_id: 'new-2', created: 2_000_000_000_000, text: 'newest'},
          {message_id: 'new-1', created: 1_999_999_900_000, text: 'newer'},
        ]}}),
      };
    }
    assert.ok(body.query.includes('before: \"new-1\"'));
    return {
      ok: true, status: 200,
      json: async () => ({data: {latest: [
        {message_id: 'old-enough', created: 1_999_900_000_000, text: 'old'},
      ]}}),
    };
  };
  const pagedMessages = await feed.fetchMessages({
    leagueId: '1389332241724764160',
    token: 'safe-token',
    sinceMs: 1_999_950_000_000,
    fetchImpl: pagedFetch,
  });
  assert.equal(pageCall, 2);
  assert.deepStrictEqual(pagedMessages.map(x => x.message_id), ['new-2', 'new-1', 'old-enough']);

  await assert.rejects(
    () => feed.fetchMessages({
      leagueId: '1389332241724764160',
      token: '',
      fetchImpl: fakeFetch,
    }),
    error => error.code === 'NO_TOKEN',
  );

  console.log('sleeper_feed tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
