# Connecting an AI assistant to OpenWhispr (MCP)

OpenWhispr ships an MCP server that lets an AI assistant read your notes, transcripts and
people — Claude Desktop, Claude Code, or any other MCP client.

Everything stays on your machine. The server talks to the running OpenWhispr app over
`127.0.0.1` only, authenticated with a token the app writes to your home directory. Nothing is
sent anywhere else, and the server has no network access of its own.

## Before you start

- **OpenWhispr must be running.** The MCP server is a thin client — it holds no data. If the app
  is closed, every tool returns "OpenWhispr is not running. Start the OpenWhispr app and try
  again."
- **Node.js is required** to run the server (the app itself does not need it). Check with
  `node --version`.

## Where the server lives

It ships inside the installed app, so there is nothing to download or install:

| Platform | Path                                                                       |
| -------- | -------------------------------------------------------------------------- |
| macOS    | `/Applications/OpenWhispr.app/Contents/Resources/mcp/server.js`            |
| Windows  | `C:\Users\<you>\AppData\Local\Programs\OpenWhispr\resources\mcp\server.js` |
| Linux    | `<install dir>/resources/mcp/server.js`                                    |

If you run OpenWhispr from a checkout instead, use `mcp/server.js` in the repo.

## Claude Desktop

Edit the config file:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

Add an `openwhispr` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "openwhispr": {
      "command": "node",
      "args": ["/Applications/OpenWhispr.app/Contents/Resources/mcp/server.js"]
    }
  }
}
```

Restart Claude Desktop. OpenWhispr's tools appear in the tools menu.

## Claude Code

From any directory:

```bash
claude mcp add openwhispr -- node /Applications/OpenWhispr.app/Contents/Resources/mcp/server.js
```

Add `--scope user` to make it available in every project rather than just the current one.

## Any other MCP client

The server speaks JSON-RPC over stdio, with no arguments and no required environment. Point your
client at `node <path>/server.js`.

## Checking it works

With OpenWhispr running:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | node /Applications/OpenWhispr.app/Contents/Resources/mcp/server.js
```

You should get a JSON line listing 14 tools. Then ask your assistant something like _"what
meetings did I have last week?"_ or _"find where we talked about pricing"_.

## What the assistant can do

Fourteen read-only tools. None of them create, edit or delete anything.

**Notes and meetings**

| Tool                   | What it does                                       |
| ---------------------- | -------------------------------------------------- |
| `list_notes`           | Recent notes, newest first, with a preview of each |
| `get_note`             | The full text of one note                          |
| `search_notes`         | Search by meaning and by keyword together          |
| `list_folders`         | Folders, with how many notes each holds            |
| `list_meeting_types`   | The meeting types a note can be classified as      |
| `list_calendar_events` | Synced calendar events and the note linked to each |

**What was actually said**

| Tool                    | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `search_transcripts`    | Search spoken words, with speaker and position in the recording |
| `list_transcriptions`   | Recent one-off dictations                                       |
| `search_transcriptions` | Keyword search across dictations                                |

**People**

| Tool                  | What it does                                                              |
| --------------------- | ------------------------------------------------------------------------- |
| `find_person`         | Resolve a name across contacts, speaker profiles and transcript labels    |
| `get_person_activity` | What someone said, where they are mentioned, which meetings they attended |
| `list_people`         | Everyone who appears, ranked by how much they appear                      |

**Housekeeping**

| Tool               | What it does                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `get_stats`        | Counts and durations per time bucket                                                                 |
| `get_index_status` | How much of each search index is built — tells an empty result apart from an index that is not ready |

If a search comes back empty, `get_index_status` is the one to check first.

## Troubleshooting

**"OpenWhispr is not running."** Start the app. If it _is_ running, quit and relaunch it — the
message also appears when the connection file is stale.

**"This version of OpenWhispr does not support the MCP server."** The installed app predates the
MCP routes. Update it.

You will also see this if you point the repo's `mcp/server.js` at an older installed app. That
pairing is the one case where the check fires in normal use. To override it while developing:

```bash
OPENWHISPR_MCP_SKIP_VERSION_CHECK=1 node mcp/server.js
```

**Nothing appears in the client.** Check the path is right — `node <path>/server.js` should print
a tool list. A wrong path usually shows up as the server failing to start rather than as an error
from OpenWhispr.

## Advanced

| Variable                            | Purpose                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `OPENWHISPR_MCP_BRIDGE_FILE`        | Point at a different connection file instead of `~/.openwhispr/cli-bridge.json`. Useful when running two builds side by side. |
| `OPENWHISPR_MCP_SKIP_VERSION_CHECK` | Set to `1` to skip the compatibility check described above.                                                                   |

## A note on what the assistant reads

These tools hand your notes and transcripts to whichever assistant you connect. That content is
whatever was said near your microphone, so treat connecting an assistant the same way you would
treat sharing the notes themselves. Tool results are also marked as untrusted data: text inside a
note or transcript is content to report on, never an instruction to follow.
