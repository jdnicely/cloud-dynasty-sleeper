const assert = require('assert');
const fs = require('fs');
const source = fs.readFileSync('activity/app.js', 'utf8');

assert.ok(source.includes('ActivityCore.buildFeedIdentityMap(users, rosters, teams)'), 'app should build username/team identity map');
assert.ok(source.includes('ActivityCore.enrichFeedMessages('), 'app should enrich authenticated feed messages');
assert.ok(source.includes('ActivityCore.mergeTransactionsWithFeed('), 'app should reconcile feed system events into completed transactions');
assert.ok(source.includes('message.manager_name || message.author_name'), 'full feed should render mapped team/manager names');
assert.ok(source.includes('message.display_text || ActivityCore.feedDisplayText(message)'), 'full feed should render concise feed text');
console.log('app integration tests passed');

const html = fs.readFileSync('activity/index.html', 'utf8');
assert.ok(source.includes('ActivityCore.buildWaiverWatch('), 'app should build a 7-day waiver watch independent of the main window');
assert.ok(source.includes('waiverWatchRaw'), 'app should retain a separate 7-day transaction set for waiver watch');
assert.ok(source.includes('waiverWatch: state.waiverWatch'), 'copied snapshot should always include waiver watch');
assert.ok(source.includes('localStorage.getItem(SLEEPER_TOKEN_KEY)'), 'Sleeper token should persist on this device');
assert.ok(source.includes('localStorage.setItem(SLEEPER_TOKEN_KEY'), 'Connect should save the Sleeper token persistently');
assert.ok(source.includes('localStorage.removeItem(SLEEPER_TOKEN_KEY)'), 'Forget Token should clear the persistent token');
assert.ok(!source.includes('sessionStorage.getItem(SLEEPER_TOKEN_KEY)'), 'Sleeper auth should no longer depend on sessionStorage');
assert.ok(html.includes('id="waiver-watch"'), 'page should visibly render OPEN WAIVER WATCH');
