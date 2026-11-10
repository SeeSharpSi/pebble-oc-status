# OpenCode Status

A Pebble watchapp for the [OpenCode Pebble plugin](../oc-plugin). It shows the sessions the
plugin knows about and lets you open them from the watch.

- A braille-style spinner marks a running session.
- A dot marks a session that needs attention. On colour watches it is green for an unread reply,
  yellow for a question, and red for a permission request. On black-and-white watches the dot keeps
  the existing single-colour treatment. A running session shows the spinner even when it also has an
  unread reply; permission and question dots still take priority.
- Up/down moves through the list. Select opens a session. Long-press Select on a completed session
  clears its green dot; on any other row it refreshes the list.
- The detail header is the session name, with the same spinner or reason-coloured dot on its right
  as the session has in the list.
- The spinner uses the same ten braille frames and 80 ms interval as the OpenCode CLI.
- Permission requests open first, then questions, then the latest reply. Permission review offers
  **Reject** or **Approve once**; permanent approval is not available.
- A session with a question opens the question as a list of choices. Select a choice to answer it
  through the plugin's `answer_question` action.
- The question text is the first row in the choices list. When selected it scrolls right-to-left to
  reveal the full text. Long-press Select opens the full question in a scrollable text view; Back or
  Select returns to the choices. Long-press an answer to open a scrollable answer view with the
  question, the full answer, and the answer's gray description from OpenCode. Short Select still
  answers a choice. Aplite keeps the simpler one-line question list.
- Otherwise the detail screen shows the latest reply text, with scrolling for longer replies. When
  the reply is displayed, the app marks it read on the watch.
- On a reply detail, Select starts dictation. Running sessions offer **Queue after run** or
  **Steer active run**; idle sessions send immediately. The plugin's receipt is shown on the watch.

The watch UI is C. All plugin access is in `src/pkjs/index.js`; the watch only receives a small
flat session list and one detail at a time over AppMessage.

## Chat status, unread, and replies

`opencode/chat_status` drives the list dots. It supplies `needs_action`, `reason`,
`permission_count`, `question_count`, and `unread`. The app also uses it to include chats with
pending permissions or questions even when they are outside the recent reply list.

Unread is the plugin’s watch-local marker, not the desktop read state. Reading a chat on the
computer does not clear the watch dot. The app calls `mark_chat_read` with the exact message ID that
was displayed, only after a complete reply is shown. If a newer reply exists, the dot correctly
remains. Long-pressing a completed list row clears its green dot without opening the session; the
phone passes the message ID from `chat_status` so the same exact reply is marked read. While a
session is running, an earlier unread reply is superseded: the row shows the spinner and does not
count as attention. Permission and question requests still take priority.

Reply text is fetched from `opencode/replies` on demand when a session is opened, then cached. The
focused `opencode/reply` source still refreshes the default or last-sent session every 20 seconds.
Older sessions outside the monitored set have no reply text; raise **Recent replies** in the plugin
settings to monitor more sessions.

## Permissions

`opencode/permission` is read on demand when a session reports a pending permission. The watch shows
the action, resources, and optional message. Permission approval is destructive and requires a
second deliberate selection; **Reject** is the default menu choice. The app never offers permanent
approval and does not retry an uncertain response. Requests too large to review safely on the watch
are left for OpenCode on the phone or computer.

## Dictation and delivery

Dictation requires a watch with a microphone and a connected phone. It is not available on Aplite.
The watch uses the system dictation confirmation screen, then uploads the transcript to PKJS in
chunks.

Reply sends pass an explicit delivery mode to `send_to_agent`:

- **Queue after run** waits for the current run to finish.
- **Steer active run** injects at the next safe turn and changes the active run.

Queue is the default offered. Steering is a deliberate selection. Failed and uncertain sends are
not retried; the plugin's receipt or error is shown.

## Requirements

- Pebble SDK 4.44 or later and `pebble-tool` 5.1 or later.
- OpenCode plugin 0.7.0 or later (`4e2c758f-8a31-4bf2-a6d9-7c40ec9b5173`) installed on the phone.
- Plugins enabled in the Pebble mobile app, with the plugin connected by password or `opencode pair`
  link.

The app requests only the `InvokeAction` permission for the OpenCode plugin, so it can answer
questions, send prompts, mark chats read, and approve permissions. Reading the plugin's sources does
not require additional app permissions.

## Build and test

```sh
npm test
pebble build
pebble install --cloudpebble
```

`npm test` runs the phone-side state tests with a fake `Pebble` and `localStorage`; it does not
need the SDK. `build/oc-status.pbw` is the sideloadable app.

## Credits

The bundled braille font is a subset of JetBrains Mono Nerd Font, licensed under the SIL Open
Font License 1.1; the license is in `resources/fonts/OFL.txt`.
