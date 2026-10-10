# ZenithMax V20 remote media

Starter and Shorts media are streamed from remote HTTPS sources. V20's scalable Shorts catalog currently discovers video files from Wikimedia Commons and accepts only CC0, Public Domain, CC BY, and CC BY-SA style licenses recognized by the discovery filter.

Each indexed item records:
- remote URL
- title
- category/topic
- source page
- source creator/artist metadata when available
- license text
- audio availability flag

V20 never invents a remote URL to fill the 567,000 target. A source must be returned by the discovery search and pass the media/license checks.


## Home videos and search
ZenithMax V20.5 can query Wikimedia Commons at search time for video-only media with open/public licenses and cache results. Each result stores the source page, creator and license metadata. Commons notes that each file has its own reuse conditions and attribution requirements, so production reuse should still be reviewed per file.
