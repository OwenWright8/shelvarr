# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately: [**Report a vulnerability**](https://github.com/OwenWright8/shelvarr/security/advisories/new). Say what you found, which version, and how to reproduce it. You'll get a reply within a week.

Only the latest release gets fixes.

## What's in scope

Shelvarr holds an admin key for Audiobookshelf and can move and delete files in the folders you give it, so these matter most:

- Getting past sign-in, or reading or changing anything without a session
- Getting the Audiobookshelf key out of Shelvarr
- Making it touch files outside its folders (crafted file or folder names included)
- The widget key doing more than reading counts

Out of scope: anything needing someone already signed in (they're the admin), Audiobookshelf's or Shelfmark's own bugs, and running it on the open internet without HTTPS.
