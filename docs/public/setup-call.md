# The paid setup call: checklist

A streamer can install Black Branch alone from [install.md](install.md), or pay one of the team for a
setup call: we install it **with** them, on **their** server, and at the end they own and run it. This
is the checklist the team member follows. The streamer keeps every key and password; the team member
never takes a copy of any of them.

## Before the call (send this to the streamer)

- [ ] A server is rented (or a home Linux box is ready): Debian stable or Ubuntu LTS, x86-64, 4 GB of
      memory or more, 2 cores, 40 GB of disk. They can sign in to it with an account that may use `sudo` (`sudo -v` asks for their password
      and says nothing else); a root login is not needed.
- [ ] The domain is chosen and they can change its DNS. They understand it is **permanent** for the
      install (the chat server is named after it).
- [ ] The front door is chosen: a free Cloudflare account with the domain on it (tunnel), or the
      server's ports 80 and 443 open (direct).
- [ ] They are signed in, in their own browser, to every account the site will use: Twitch, Kick,
      YouTube/Google, Stripe, PayPal, Ko-fi/Patreon/Streamlabs, whichever apply. Two-factor sign-in is
      on for Twitch and Kick (the developer consoles require it).
- [ ] They have somewhere safe, off the server, to keep the recovery sheet (a password manager is
      ideal).
- [ ] If backups will go to a bucket or another server: the bucket and its access key exist, or the
      SFTP account does.
- [ ] Screen sharing works. **The streamer types every password and pastes every secret**; the team
      member reads along and never asks for one to be read out or sent.

## On the call

1. [ ] Sign in to the server together, as the streamer's ordinary user. Check the box: `sudo -v`
       (the account may use sudo), `free -h` (memory), `df -h /` (disk), `cat /etc/os-release`
       (distribution).
2. [ ] Get the code and run `sudo ./install/install.sh` ([install.md §2–3](install.md#2-get-the-code)).
       Tunnel mode: the streamer opens the Cloudflare link and picks the domain. Direct mode: check the
       three DNS records resolve first (`getent hosts example.com api.example.com matrix.example.com`).
3. [ ] Wait for "every service is healthy" and the setup link. `sudo blackbranch status` should show
       every service healthy.
4. [ ] The streamer opens the setup link in their own browser and makes their account (page 1).
5. [ ] **Recovery sheet:** the streamer saves the backup passphrase in their password manager now, and
       ticks the box only after it is saved. Explain: without it no backup can ever be read.
6. [ ] Your site, Points: their words, their legal details (who runs the site, a contact address),
       their time zone from the list, and the site icon if they have one.
7. [ ] Modules: switch on only what they will use today; everything can be added later. OBS is set
       up after setup, in Admin Panel → Utility → OBS and → Overlays.
8. [ ] Each platform and payment page: open the provider's page from the link on the setup page, paste
       the values it shows, fill the fields, press **Check** on each value until it passes. Stripe: make the
       **restricted** key with exactly the listed permissions, never the full secret key. Behind
       Cloudflare on the Free plan, turn Bot Fight Mode off, because no rule can let Stripe's webhook
       past it. On Pro or higher, use Super Bot Fight Mode with a skip rule for `/api/billing/webhook`
       (the Stripe page shows how).
9. [ ] Community: create the space, `#general` and `#forum`. Leave federation off unless they ask for it.
10. [ ] Finish: the quiet hour (a time they are never live: security updates run then), backups to a
        bucket or another server if they have one, and wait for the test backup to pass.
11. [ ] Sign in on the site; post in site chat and in `#general`; check the site's name.
12. [ ] Open the Doctor together (`sudo blackbranch doctor`, or Admin Panel → Doctor). Go through every
        row that is not green. Rows for parts they skipped are expected.

## Before you hang up

- [ ] Walk through [operate.md](operate.md): the doctor, backups and `restore --verify`, how updates
      arrive (security releases by themselves at the quiet hour, feature releases by the Apply
      button), how to reset a password.
- [ ] They know where `.env` is (`/opt/blackbranch/.env`) and that it holds every secret: back it up
      off the server with the recovery sheet, never share it.
- [ ] They know how to get help: the Discord or a setup-help issue, with `sudo blackbranch doctor --report` attached (it
      holds no secrets).
- [ ] Sign out of the server. If you were given a temporary account or an SSH key, remove it while
      they watch (`sudo deluser <name>`, or the key's line in `~/.ssh/authorized_keys`).
- [ ] Nothing of theirs leaves with you: no copy of `.env`, the passphrase, keys or tokens, and no
      screenshots of them.
