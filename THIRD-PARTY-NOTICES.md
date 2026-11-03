# Third-party notices

Muster's own code is under the MIT licence (see `LICENSE`). It also includes or is built with the
following software. Their full licence texts are in the `licenses/` folder.

| Software | Where it is used | Licence |
| --- | --- | --- |
| Firebase JS SDK 10.14.1 (`@firebase/app`, `auth`, `firestore`, `component`, `logger`, `util`, `webchannel-wrapper`), © Google LLC | `server/web/vendor/firebase.js`: sign-in and saving parades in the web version | Apache License 2.0, `licenses/Apache-2.0.txt` |
| idb 7.1.1, © 2016 Jake Archibald | bundled inside `vendor/firebase.js` | ISC, `licenses/idb-ISC.txt` |
| tslib 2.9.1, © Microsoft Corporation | bundled inside `vendor/firebase.js` | 0BSD, `licenses/tslib-0BSD.txt` |
| Go standard library, © The Go Authors | compiled into the laptop apps (`Muster.exe`, `muster-mac-*`) | BSD 3-Clause, `licenses/Go-BSD-3-Clause.txt` |

`vendor/firebase.js` is an unmodified esbuild bundle of the packages above, made with:

```
npm i firebase@10.14.1 esbuild@0.23.1
npx esbuild entry.js --bundle --format=esm --minify --target=es2020,safari15 --outfile=firebase.js
```

where `entry.js` re-exports the functions listed at the top of `server/web/cloud.js`.
