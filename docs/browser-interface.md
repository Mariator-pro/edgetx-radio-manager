# Browser interface

[Back to the README](../README.md)

Besides the desktop app, EdgeTX Radio Manager can run in your web browser. It needs the app [running from source](development.md#running-from-source) (Node.js and `npm install`, `npm run build`).

```sh
npm start
```

Starts the server on a free port and opens the browser, with the same pages as the desktop app. If it already runs, `npm start` opens the running one again. Language and theme are kept in the [data folder](../README.md#your-data-on-the-computer), so they stay the same in the browser and in the desktop app.

The address it opens carries a key for this start behind `#`; without it other web pages and programs on the computer cannot use the interface, and the browser never sends it anywhere. To open the interface in another browser or window, run `npm start` again or copy the whole address the terminal shows.

Everything else works as described in the [README](../README.md#using-it). The command `npm run cli -- ui` from the [command line](command-line.md) does the same as `npm start`.
