# Account Photo storage and validation (#247)

`POST /v1/account-photo` accepts one raw JPEG, PNG or WebP body with a known
`Content-Length` no greater than 2 MiB, dimensions no greater than 8192 pixels
per axis and no greater than 40,000,000 pixels total. The service streams it through a
Cloudflare `FixedLengthStream` to the private `FILES` R2 binding. Better Auth's
`user.image` stores only `/v1/account-photo/{photoId}`; a separate random R2
object key and validated metadata remain in D1. `GET /v1/account-photo/{photoId}`
and `DELETE /v1/account-photo` require the owner's live Better Auth session.
Reader State and administrator sessions are not photo authority.

Validation is bounded structural validation, not a decoder or malware scanner.
Every format is limited to 8192 pixels on either axis and 40,000,000 total
pixels:

- JPEG requires a valid SOI, a structurally sized frame within those dimension
  limits, a valid SOS marker and non-empty scan data ending with EOI.
- PNG requires its signature, one valid IHDR (dimensions and legal color/depth
  combination) within those dimension limits, non-empty IDAT data and a terminal
  IEND with correctly bounded chunks. PNG chunk CRCs and compressed pixel data
  are not verified.
- WebP requires matching RIFF length, bounded chunks and a structurally valid
  VP8/VP8L frame header within those dimension limits. Animated WebP containers
  (`ANIM`/`ANMF`) are outside this still-photo endpoint's format subset.

The service does not decompress image payloads or prove that every accepted
stream can be fully rendered. Malformed compressed pixels, decoder exploits or
polyglot payloads that retain a valid container structure are outside this
validation guarantee. If the product needs stronger image assurance, add a
separately reviewed sandboxed decoder/re-encoder and malware-scanning stage
before changing the saved reference; do not buffer the whole upload in a Worker.

In local development/tests, Wrangler binds `FILES` to its local R2 simulation.
Remote `FILES` remains optional: `FILES_BUCKET` must be set to the exact
target-specific `*-files` bucket name after an operator provisions that bucket.
The deployer neither creates nor shares R2 buckets; blank values keep existing
Workers bootable and photo operations return `service-unavailable`.
