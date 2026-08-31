# deploy/

Two systemd units. One timer, one oneshot service, two processes in sequence.

| file | what it is |
|---|---|
| `tg.service` | `tg sync chats --once --verbose` then `tg ship`, `Type=oneshot`, aborts on the first failure |
| `tg.timer` | `OnCalendar=*-*-* 04:17:00`, `Persistent=true` |

`install.sh` is **deferred**, not forgotten. It is the only non-trivial artefact
in TASK-14 — create the `tg` user, `install -d -m 0700 -o tg /srv/tg`, clone,
`pnpm install --prod`, symlink the bin, install both units, `systemctl enable
--now` — and it cannot be written honestly without a VM to run it against
(TASK-16 has not happened; there is no host). Writing it blind would produce a
script nobody has executed, which is worse than a documented gap. Until then:

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin tg
sudo install -d -m 0700 -o tg -g tg /srv/tg
sudo install -m 0644 deploy/tg.service deploy/tg.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tg.timer
```

## /etc/tg.env (root:tg 0640)

```sh
TG_BRAIN_MAP=7=personal,12=proximata
```

`TG_BRAIN_MAP` maps a Telegram folder id to a gbrain source id. A file whose
`folder_ids` contains an unmapped folder **fails the run**; ship never picks a
default brain, because a private chat landing quietly in the wrong brain is the
one failure nobody would notice.

Telegram secrets go in the psst vault, not here. `readSecret()` resolves env →
local vault → global vault, so `EnvironmentFile` remains the fallback if psst
headless unlock turns out not to work on Linux — that is why the line reads
`EnvironmentFile=-` with the leading dash.

## The boundary this layout exists to enforce

`ExecStart` runs twice, in order, as two processes:

1. `tg sync chats --once --verbose` holds a full Telegram account credential and never calls
   gbrain or an LLM.
2. `tg ship` talks to gbrain and holds no Telegram credential. It is a
   subcommand of the same binary for the human's convenience, but a separate
   process, and its import graph is asserted clean by eval-48.
