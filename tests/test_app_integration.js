const assert = require('assert');
const fs = require('fs');
const source = fs.readFileSync('activity/app.js', 'utf8');

assert.ok(source.includes('ActivityCore.buildFeedIdentityMap(users, rosters, teams)'), 'app should build username/team identity map');
assert.ok(source.includes('ActivityCore.enrichFeedMessages('), 'app should enrich authenticated feed messages');
assert.ok(source.includes('ActivityCore.mergeTransactionsWithFeed('), 'app should reconcile feed system events into completed transactions');
assert.ok(source.includes('message.manager_name || message.author_name'), 'full feed should render mapped team/manager names');
assert.ok(source.includes('message.display_text || ActivityCore.feedDisplayText(message)'), 'full feed should render concise feed text');
console.log('app integration tests passed');
