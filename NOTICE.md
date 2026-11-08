GrabPost - Downloader for Reddit
Third-Party Notice

GrabPost's own code is licensed under the PolyForm Noncommercial License
1.0.0 (see LICENSE). The third-party components listed below keep their own
licenses.

This extension was independently developed. Its feature set was inspired by
the general category of open-source Reddit media downloader extensions,
including the publicly available "redditgrab" project
(https://github.com/sebastianwd/redditgrab), which is distributed under the
MIT License.

No source code from that project was copied, adapted, or reproduced. All
code in this extension (manifest, background script, content script,
side panel, and supporting modules) was written independently.

Since version 1.49 (November 2026), the public source of that project was
read for comparison: its approaches to reading the audio track from Reddit's
HLS playlist, shutting down page scripts after an extension update and
pacing bulk downloads were studied as ideas. GrabPost's implementations of
these ideas are its own code and differ in structure; no code was copied.

Third-party components that are included:
- ffmpeg.wasm (https://github.com/ffmpegwasm/ffmpeg.wasm), used to merge
  video and audio in the browser: libs/ffmpeg and libs/util are
  @ffmpeg/ffmpeg and @ffmpeg/util (MIT License); libs/core is
  @ffmpeg/core, an FFmpeg build distributed under GPL-2.0-or-later, with
  its source code available from the ffmpeg.wasm project.
- Geist font (docs/assets/fonts), SIL Open Font License 1.1, used only by
  the website in docs/.

This notice is included as a transparency measure only and does not
indicate that this project is a derivative work requiring attribution
under the MIT License.

---

Original project license reference (for transparency only):

MIT License

Copyright (c) sebastianwd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
