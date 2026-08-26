# One-Time GitHub Setup

These steps keep the working copy in GitHub. Your Mac is only used to download the ZIP and upload it into a temporary browser-based GitHub Codespace; the ongoing sync and JSON storage live in GitHub.

## 1. Create the GitHub repository

1. Sign in to GitHub.
2. Click **+** in the upper-right corner → **New repository**.
3. Repository name: `cloud-dynasty-sleeper`.
4. Choose **Public** or **Private**:
   - **Public:** easiest if you want ChatGPT or other web tools to read the synced files directly from GitHub later.
   - **Private:** keeps the Git history restricted, but tools without access to your GitHub account cannot read it directly.
5. Check **Add a README file**. This gives the new repository an initial `main` branch.
6. Click **Create repository**.

## 2. Open a browser-based Codespace

1. In the new repository, click the green **Code** button.
2. Open the **Codespaces** tab.
3. Click **Create codespace on main**.
4. A browser-based VS Code workspace opens. Nothing needs to remain installed or stored locally for the sync to run afterward.

## 3. Upload and unpack the package

1. Download `cloud-dynasty-sleeper.zip` from ChatGPT.
2. In the Codespace file explorer, drag `cloud-dynasty-sleeper.zip` into the repository root.
3. Open **Terminal → New Terminal** in the Codespace.
4. Run exactly:

```bash
unzip -o cloud-dynasty-sleeper.zip
rm cloud-dynasty-sleeper.zip
git add .
git commit -m "Set up Cloud Dynasty Sleeper sync"
git push
```

The ZIP contains the files at its root, so the `unzip` command places `.github/`, `sync/`, `tests/`, `config.json`, and the documentation directly into the repository.

## 4. Run the first Sleeper sync

1. Return to the repository page on GitHub.
2. Click the **Actions** tab.
3. In the left sidebar, choose **Sync Sleeper League**.
4. Click **Run workflow**.
5. Leave the branch as `main` and click the green **Run workflow** button.
6. Open the new workflow run and confirm all steps have green check marks.

The first successful run creates the `data/` directory and commits the current Cloud Dynasty league data back to GitHub.

## 5. Verify the data

Back on the repository **Code** tab, confirm you now see `data/` containing at least:

- `league.json`
- `users.json`
- `rosters.json`
- `traded_picks.json`
- `nfl_state.json`
- `drafts/`
- `transactions/`

Open `data/league.json` and confirm the league ID is `1389332241724764160`.

## 6. Done — GitHub takes over

The workflow is scheduled at minute 17 every six hours in UTC. Your computer does not need to be on, and you do not need to manually download Sleeper JSON going forward.

When Sleeper data is unchanged, the workflow creates no commit. When something changes, the GitHub Actions bot commits the new canonical JSON, giving you a historical Git trail automatically.

## If the workflow cannot push

If the Action reaches the commit step but reports a permissions error:

1. Open **Settings → Actions → General** in the repository.
2. Scroll to **Workflow permissions**.
3. Select **Read and write permissions** if GitHub allows that option for your account/repository.
4. Save, return to **Actions**, and run **Sync Sleeper League** again.

The workflow itself already requests `contents: write`; this setting is only a fallback for repository or organization policies that restrict the GitHub Actions token.

## If you want ChatGPT to read the repo later

If the repository is **Public**, send ChatGPT the repository URL once it is set up. The current JSON and Git history can then be inspected from GitHub without you uploading a local copy each time.

If the repository is **Private**, the sync still works exactly the same, but ChatGPT will need an authorized GitHub connection in the product or you will need to provide the relevant files when you want analysis.

## v2 roster-name update

After installing this update, run **Actions → Sync Sleeper League → Run workflow** once. A manual run performs the full player refresh and should create:

- `data/players.json`
- `data/rosters_resolved.json`

Open `data/rosters_resolved.json` to verify that Sleeper player IDs now appear with player names and that each roster is separated into starters, bench, reserve, and taxi.

The workflow performs one full player-map refresh daily at 00:17 UTC. The 06:17, 12:17, and 18:17 UTC runs reuse the compact cached player map and refresh the rest of the league data.

## v3 Draft Mode update

This update adds only static Draft Mode files, tests, and documentation. It does not delete or replace your existing `data/` history and does not change the six-hour Sleeper sync.

### Install the overlay ZIP into the existing Codespace

1. Open the existing `cloud-dynasty-sleeper` Codespace.
2. In the terminal, first catch up with any commits made by the automatic Sleeper workflow:

```bash
git pull --rebase origin main
```

3. Drag `cloud-dynasty-sleeper-draft-mode-update.zip` into the repository root.
4. Run:

```bash
unzip -o cloud-dynasty-sleeper-draft-mode-update.zip
rm cloud-dynasty-sleeper-draft-mode-update.zip
git add .
git commit -m "Add Cloud Dynasty live Draft Mode"
git pull --rebase origin main
git push
```

The second `git pull --rebase` is intentional. The automatic Sleeper workflow may have committed fresh `data/` files while your Codespace was open; rebasing before the push prevents a non-fast-forward rejection without overwriting those data commits.

If Git reports a **CONFLICT** during either rebase, stop and resolve the conflict before pushing. Do not force-push.

### Enable GitHub Pages

1. Open the repository's **Settings** tab.
2. Under **Code and automation**, click **Pages**.
3. Under **Build and deployment → Source**, select **Deploy from a branch**.
4. Select branch **main** and folder **/(root)**.
5. Click **Save**.

Once the deployment is green, Draft Mode is available at:

**https://jdnicely.github.io/cloud-dynasty-sleeper/draft/**

Then follow `DRAFT-DAY.md`, starting with the built-in Mock rehearsal.

## Direct draft override

For Sleeper mock drafts that do not appear in the league draft list, open Draft Mode with the draft ID in the URL:

```text
https://jdnicely.github.io/cloud-dynasty-sleeper/draft/?draft=1398157268502986752
```

When `?draft=` is present, Draft Mode ignores league auto-detection and polls that exact Sleeper draft every 5 seconds. The page labels the source `DIRECT DRAFT` and displays the draft ID so it is obvious which board is being watched. Remove the `?draft=` query to return to normal Cloud Dynasty auto-detection.

