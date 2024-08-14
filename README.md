[![Ziglist](./assets/img.png)](https://ziglist.org)

Ziglist is a web-based tool to discover Zig projects and packages. Visit [ziglist.org](https://ziglist.org).

How it works: Ziglist periodically indexes GitHub for Zig-related repositories, saves it in a SQLite database, and serves it. Ziglist lives in a single JavaScript [file](./src/main.jsx). It runs on the Deno runtime.

To run Ziglist locally:

- Install Deno, refer to the [documentation](https://docs.deno.com/runtime/manual/getting_started/installation/)
- `git clone https://github.com/pixqc/ziglist.git`
- `deno task dev`

Help wanted! If you found:

- c/cpp repo built with Zig, that's not on Ziglist
- repo on Ziglist that's not Zig-related
- missing dependencies in one of the repos

Please open an issue or a PR, ctrl+f for `HELP:` in the [file](./src/main.jsx).

Ziglist's visual design is inspired by [https://github.com/piotrkulpinski/openalternative](https://github.com/piotrkulpinski/openalternative)

Check out the [blogpost](https://pixqc.com/ziglist)!
