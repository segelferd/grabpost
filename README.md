# GrabPost - Downloader for Reddit

**Browser extension that adds a Download button to every Reddit post. Images, galleries, videos with sound, GIFs, Redgifs and Imgur links; bulk download of whole subreddits and profiles; follow sources and get new posts automatically. Chrome, Edge, Brave, Opera (Chromium) and Firefox.**

🌐 **Website:** [segelferd.github.io/grabpost](https://segelferd.github.io/grabpost/) · **Current version:** 1.50.6 · [Changelog](CHANGELOG.md) · [Privacy policy](https://segelferd.github.io/grabpost/privacy/)

## Features

### ⬇ One click on every post
- **Orange Download button** in each post's vote/share row: feeds, profiles, search results (Posts and Media tabs), single post pages, **new and old Reddit**
- **Images, galleries, GIFs, Redgifs and Imgur** links
- **Videos with sound**: Reddit stores audio separately; GrabPost finds the right audio track (DASH or HLS playlist) and merges it in the browser with FFmpeg (WebAssembly)
- **Comment images**, right-click **Download** entry, **Alt+Shift+D** downloads the post in the middle of the screen

### ⚡ Bulk download
- **Page mode** scrolls the page and downloads everything on it; the post being downloaded is outlined, posts are resolved while they are on screen
- **Fast mode** reads a subreddit, profile, multireddit or search straight from Reddit's data, without scrolling; skips what you have and stops at already-downloaded posts
- **Saved posts** download in one go (logged in)
- Media type filter, date range, scroll direction, "re-download posts downloaded before" switch
- Reddit rate limits (429) are respected: GrabPost waits as long as Reddit asks and carries on

### 🔔 Follow subreddits and users
- Scheduled checks (30 min to 24 h) with **desktop notifications**, optional **auto-download**
- Per-source filters: media type, NSFW, keywords
- **Favorites**: up to 10 sources checked every 5 to 60 minutes
- Missed checks catch up automatically a couple of minutes after the browser starts
- Drag to reorder, export/import the list (JSON or plain text), sync through your browser account

### 🗂 Files, history, backups
- Folder and file name templates: `{subreddit}` `{user}` `{date}` `{timestamp}` `{title}` `{filename}`, nested folders with `/`, optional gallery subfolders
- **Duplicate detection** by content, not just the address: images (exact or visually the same) and videos (same upload, or same size and first 1 MB)
- **History** with search, "✓ Downloaded" badges and faded posts on Reddit
- **Download manager (IDM) compatibility**: files are fetched by the extension and handed to the browser, so folder names survive
- **Automatic backups** (daily and every 50 downloads) to `Downloads/GrabPost-Yedek`, restore screen on a fresh install, rebuild history from the browser's download list
- Optional title text burned into images and videos

### 🌍 15 languages
English, Türkçe, Deutsch, Français, Español, Português (BR), Italiano, Русский, Čeština, العربية, हिन्दी, Bahasa Indonesia, 日本語, 한국어, 简体中文

## Install

- **Chrome, Edge, Brave, Opera**: [Chrome Web Store](https://chromewebstore.google.com/detail/ejkhdjmfnmcjclhpecgoiabcigmmpkia)
- **Firefox**: [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/grabpost-downloader-for-reddit/)

Updates install automatically from the store.

Manual install: the zip files are on [Releases](https://github.com/segelferd/grabpost/releases/latest). Unzip `grabpost-vX.Y.Z.zip`, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `grabpost` folder. A manual install is a separate copy from the store version; do not run both at once, or every post gets two buttons.

## Privacy

No analytics, no tracking, no servers. GrabPost only talks to Reddit (reddit.com, redd.it, redditmedia.com) and the hosts of the media you download (Redgifs, Imgur and similar). Settings, follow list and history stay in your browser. Full policy: [segelferd.github.io/grabpost/privacy](https://segelferd.github.io/grabpost/privacy/).

## Building

The Chrome version is the repository itself: no build step, no bundler, the files are the hand-written source.

The Firefox package is generated from the same source:

```
cd tools
npm install
npm run firefox
```

`tools/build-firefox.mjs` bundles the background modules into one classic script with esbuild (Firefox does not get an ES module background), turns `side_panel` into `sidebar_action`, removes Chrome-only permissions and the Chrome `key`, and adds the Gecko ID. Output: `../grabpost-firefox/` and `../outputs/grabpost-firefox-vX.Y.Z.zip`.

Other tools:
- `tools/i18n-add.py` merges new UI strings (`tools/i18n/*.json`, 15 languages each) into `locales.js`
- `tools/site/` builds the website in `docs/` (`python3 tools/site/build_site.py`)

## License

[PolyForm Noncommercial License 1.0.0](LICENSE): free to use, study, change and share for any noncommercial purpose. Commercial use is not permitted. Third-party components in `libs/` (ffmpeg.wasm) and the website font keep their own licenses, see [NOTICE.md](NOTICE.md).

## Credits

FFmpeg (WebAssembly build, `libs/`), Geist font (SIL Open Font License, website only). See [NOTICE.md](NOTICE.md).

GrabPost is an independent project and is not affiliated with Reddit.

☕ [Buy Me a Coffee](https://buymeacoffee.com/segelferd)
