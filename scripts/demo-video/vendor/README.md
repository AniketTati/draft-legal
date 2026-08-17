# vendor/

`anime.esm.js` — [anime.js](https://github.com/juliangarnier/anime) v4.1.4, MIT, © Julian Garnier.

Vendored rather than added to the workspace's `package.json`: this is tooling for producing a
video, not a runtime dependency of the app, and pinning the exact bytes means a take recorded in
six months looks the same as one recorded today. `intro.mjs` serves it to the page over a routed
fake origin so the page can `import` it as a real ES module — inline `<script type="module">`
cannot, because the bundle ends in an `export` statement.
