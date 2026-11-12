# Paging me

- When I ask you to watch a change and page me if it goes wrong, page me with `fleet page` when the tripwire I named fires. `fleet page --help` lists the flags. Page for nothing else, and never send a test page unless I ask for one.
- Give each tripwire its own `--key`. Put what happened in `--title`, and how to undo it in `--description`. Keep customer data and internal numbers out of both, since the alert shows in my organization's alert list.
- When `fleet page` exits 1, the page did not reach me. Send it once more with the same key, which never pages twice. When that fails too, tell me another way, such as a Slack message.
- When the tripwire clears or I take over, withdraw the page with `fleet page --key <the same key> --resolve`.
