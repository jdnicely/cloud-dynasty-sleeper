# Cloud Dynasty Draft Day Guide

Draft Mode is a live browser view for Cloud Dynasty. It reads Sleeper directly every five seconds, so the six-hour GitHub sync is **not** in the critical path during the draft.

Production URL after GitHub Pages is enabled:

**https://jdnicely.github.io/cloud-dynasty-sleeper/draft/**

## 1. Enable GitHub Pages once

1. Open `https://github.com/jdnicely/cloud-dynasty-sleeper`.
2. Click **Settings**.
3. In the left sidebar under **Code and automation**, click **Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Choose branch **main** and folder **/(root)**.
6. Click **Save**.
7. Wait for the Pages deployment to finish, then open the production URL above.

The repository is already public, so the Draft Mode page will also be public. Draft Mode does not contain credentials and cannot make changes to Sleeper because Sleeper's API is read-only.

## 2. Rehearsal #1 — built-in Mock Mode

This tests the complete Draft Mode interface without depending on Sleeper.

1. Open the Draft Mode URL.
2. Click **Mock rehearsal**. You can also open the page with `?mock=1` appended to the URL.
3. Choose **Mock Team 1** under **My roster**.
4. Confirm the board begins at pick **1.01**.
5. Click **Advance pick** three times.
6. Confirm Recent picks fills in and the on-the-clock highlight advances.
7. Click **Advance 5** and confirm the board jumps forward five picks.
8. Confirm **Upcoming picks** still shows the selected roster's future picks and reflects the built-in traded-pick examples.
9. Click **Copy ChatGPT Snapshot**.
10. Paste the result into ChatGPT with: **“I'm on the clock. What should I do?”**
11. Confirm the pasted snapshot includes the draft status, current pick, selected roster, remaining owned picks, and drafted players.
12. Click **Reset mock** and confirm the board returns to 1.01.

This rehearsal validates the UI, draft-order math, traded-pick ownership, selected-roster tracking, and ChatGPT handoff.

## 3. Rehearsal #2 — real Sleeper API test

Before the actual Cloud Dynasty event, test the live API path with a Sleeper mock draft or temporary Sleeper test league.

### If the Cloud Dynasty draft room itself supports a Sleeper mock draft

1. Start/open the Sleeper mock draft from the Cloud Dynasty league.
2. Open Draft Mode in **Live Sleeper** mode.
3. Leave the Draft dropdown on **Auto-detect active draft**.
4. If the mock appears in the league's draft list, Draft Mode should select the `drafting` draft automatically.
5. Make several picks in Sleeper and confirm they appear on Draft Mode within approximately five seconds.

### If you use a temporary Sleeper test league

Draft Mode supports a test-league override without editing GitHub. Append the test league ID to the URL:

`https://jdnicely.github.io/cloud-dynasty-sleeper/draft/?league=TEST_LEAGUE_ID`

Replace `TEST_LEAGUE_ID` with the temporary Sleeper league's numeric ID. Draft Mode then auto-detects drafts for that league instead of Cloud Dynasty.

Use this to verify the entire real path:

**Sleeper draft → Sleeper API → Draft Mode browser → Copy ChatGPT Snapshot → ChatGPT**

After the rehearsal, remove the `?league=...` parameter to return to Cloud Dynasty.

## 4. What Auto-detect does

Every live refresh checks the league's drafts and selects in this order:

1. newest draft with status `drafting`;
2. newest draft with status `pre_draft`;
3. newest available draft.

If you want a different draft, choose it manually in the Draft dropdown. Choose **Auto-detect active draft** again to return to automatic selection.

## 5. Pick ownership and traded picks

The board columns are the original Sleeper draft slots. Draft Mode checks Sleeper's draft traded-pick data for each round and displays the **current roster owner** of that pick.

That means your **Upcoming picks** list is based on current ownership, not merely the original draft position.

## 6. Actual draft-day workflow

Keep two tabs open:

- Sleeper draft room
- Cloud Dynasty Draft Mode

Draft Mode polls Sleeper every five seconds while its tab is visible. If you switch away from the tab, polling pauses to avoid wasting calls and immediately refreshes when you return.

When your pick is getting close:

1. Confirm your roster is selected under **My roster**.
2. Look at **Upcoming picks**, **Recent picks**, and the board.
3. In ChatGPT, say **“Refresh the Cloud Dynasty draft”** if ChatGPT can reach the live page/API.
4. If ChatGPT cannot reach it, click **Copy ChatGPT Snapshot** and paste it with **“I'm on the clock.”**

The copy button is the guaranteed fallback; you should never need to manually type the picks.

## 7. Refresh behavior

- Live Mode refresh interval: **5 seconds**.
- **Refresh now** forces an immediate update.
- If one Sleeper request fails, the page keeps the last successful board visible and automatically tries again on the next interval.
- The status banner will show the error instead of blanking the board.
- Mock Mode makes no Sleeper API calls.

## 8. What Draft Mode does not do

Draft Mode is a live board, not a ranking engine. It does **not** automatically decide who the best available player is. That strategy remains in ChatGPT, where the live draft state can be combined with your roster, league format, draft capital, trade opportunities, and current player analysis.

It also does not create five-second Git commits. The normal GitHub Action continues to preserve the long-term league history at its existing schedule.

## 9. Final pre-draft checklist

Run this at least a few days before the actual event:

- [ ] Production Draft Mode URL opens in a private/incognito browser.
- [ ] Mock rehearsal advances and resets correctly.
- [ ] My roster selection persists after refreshing the page.
- [ ] Copy ChatGPT Snapshot successfully pastes into ChatGPT.
- [ ] A Sleeper mock draft or temporary test-league draft updates on the page within about five seconds.
- [ ] Traded picks display under the correct current owner.
- [ ] Manual draft selection works.
- [ ] Auto-detect returns to the active draft after selecting Auto.
- [ ] Refresh now works.
- [ ] Phone/tablet layout is readable if you plan to use one on draft day.

## Direct draft override

For Sleeper mock drafts that do not appear in the league draft list, open Draft Mode with the draft ID in the URL:

```text
https://jdnicely.github.io/cloud-dynasty-sleeper/draft/?draft=1398157268502986752
```

When `?draft=` is present, Draft Mode ignores league auto-detection and polls that exact Sleeper draft every 5 seconds. The page labels the source `DIRECT DRAFT` and displays the draft ID so it is obvious which board is being watched. Remove the `?draft=` query to return to normal Cloud Dynasty auto-detection.

