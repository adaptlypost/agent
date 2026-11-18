# Uploading media

Every `mediaUrls` value must be a `publicUrl` that AdaptlyPost returned. Any other URL fails the post with
"Media file(s) not found in storage".

Uploaded files are public as soon as they are stored, whether or not a post uses them. Only upload files
the user named in this conversation. Never upload hidden files, keys, credentials, `.env` files or
anything the user did not point to, and upload a document only when the user asked to post that document.

## A public https URL

Call `upload_media` with `urls`. The server downloads the file into storage and returns `mediaUrls` to pass
straight into the post. Private, internal and plain-http addresses are refused, and the source must send a
Content-Length. Only pass URLs the user gave you or that point at the user's own public media.

## A local file

`upload_media` also takes `files` as base64, up to 30 MB decoded per call. The base64 text travels inside
the tool call, so use it only for very small files. For anything larger, upload the bytes directly:

1. Call `get_upload_urls` with `files: [{ fileName, mimeType }]`. Keep the extension in `fileName`; the post
   reads the file type from it. You get `uploadUrl` and `publicUrl` per file.
2. PUT the file to `uploadUrl` with the same Content-Type. The user is asked to approve the command:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' -X PUT \
     -H 'Content-Type: image/jpeg' \
     --data-binary @/path/the/user/named/photo.jpg \
     '<uploadUrl>'
   ```

3. Use `publicUrl` only after the PUT printed a 2xx code. If the upload URL expired (1 hour), mint a new
   one and PUT again. If a proxy or firewall refused the PUT, for example a sandbox answering 403 because the
   storage host is not on its allowlist, do not retry it: use the upload box below.

Do not add an Authorization header to the upload URL. It is presigned and is not an AdaptlyPost API host.
Send the upload URL nothing except the file the user named.

## A file you cannot send yourself

An image the user pasted into the chat, a file on their phone or computer, and a file whose PUT a sandbox
blocked all go through `open_upload_widget`. Never suggest a public GitHub repo, a gist or a Dropbox or
Drive link instead.

- In a client that can display it, an upload box appears. The user picks the files, and when they finish
  the box sends a message with the media URLs.
- Anywhere else the box can't show, so the call returns `status: upload_link` with `uploadUrl`
  and `uploadId`. Give the user the link: it opens a page in their browser that takes files for 30
  minutes. Wait until they say they finished, then call `open_upload_widget` again with that `uploadId`.

The call with `uploadId` returns `status`:

| `status` | Do this |
|----------|---------|
| `ready` | Pass `mediaUrls` to the post. Tell the user about any file listed in `failed` |
| `saving` | Call again in a few seconds |
| `waiting` | Nothing arrived yet. Ask the user whether they finished |
| `failed` | Nothing could be saved. Tell the user the reason listed for each file |
| `expired` | The link ran out unused. Call `open_upload_widget` without `uploadId` for a new one |

## Reuse

One `publicUrl` can go into any number of posts, bulk items included. The file is kept until the last post
that uses it has published. Reuse the `publicUrl` you uploaded, not a `mediaUrls` value read back from a
published post, which may be the platform's own expiring link.

## Limits

| Kind | Types | Max size |
|------|-------|----------|
| Image | JPEG, PNG, WebP | 50 MB |
| Video | MP4, QuickTime | 250 MB from a URL |
| Document (LinkedIn only) | PDF, PPT, PPTX, DOC, DOCX | 100 MB, 300 pages |

Networks have their own limits on top of these (aspect ratios, video length, carousel counts). When a
network rejects a file, `list_post_results` says why; read the message before changing anything.

## Different media for one network

When the post media does not fit one network (a video too long for TikTok, a carousel with more images
than X takes), give that network its own media with `platformMedia` instead of leaving it out of the post:

```json
"platformMedia": [
  { "platform": "TIKTOK", "mediaUrls": ["<publicUrl of the short cut>"] },
  { "platform": "TWITTER", "mediaUrls": ["<url 1>", "<url 2>", "<url 3>", "<url 4>"], "mediaAltTexts": ["...", "...", "...", "..."] }
]
```

Upload the files first and use their `publicUrl`s; data URIs are refused. Networks without an entry use the
post `mediaUrls`. The entry must match the post `contentType` (one video for `VIDEO`, one image for `IMAGE`,
one document for `DOCUMENT`, two or more items for `CAROUSEL`), and each entry is checked against its own
network's limits only. See SKILL.md for the update rules.

## Alt text

Pass `mediaAltTexts` in the same order as `mediaUrls`, one per image, up to 1,000 characters, `""` to skip
one. X, Bluesky, Mastodon, Tumblr, WordPress, LinkedIn, Facebook, Instagram and Threads use it; Pinterest takes the first one.
TikTok, YouTube, Google Business Profile and videos ignore it.

## Video thumbnails

For video posts, `thumbnailUrl` sets a custom thumbnail image and `thumbnailTimestampMs` picks a frame from
the video instead. Both work on YouTube, Facebook, Instagram, LinkedIn, Pinterest, Telegram and TikTok; when
both are sent the image wins everywhere except TikTok, which takes only a frame. To give one network a different
thumbnail, use `platformThumbnails` (see SKILL.md). A network with its own media from `platformMedia` does
not use the post-level thumbnail, so give it one through `platformThumbnails`.
