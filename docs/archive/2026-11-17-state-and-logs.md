# Archived state notes and verification logs

Moved out of `CLAUDE.md` on 2026-11-17 during the docs-hygiene pass. These
are **point-in-time** observations, not rules and not guaranteed current.
Nothing here is verifiable from the repository; treat as history.

## Seller state (as written in "What this project is", ~late May 2026)

- Ryan's (`ryan_5050`) original 36 auctions all ended in early May 2026 and
  were shown in the ended section; the owner's (`boilerpaulie`) auctions
  started rolling in late May 2026.
- As of late May 2026 Ryan had zero active listings, so the adaptive seller
  poll kept him asleep (30 min between checks) and the active API budget was
  effectively one seller. (The mechanism is documented in
  `docs/architecture.md`; the "currently dormant" part is state.)

## Live verification logs

- **PR #30 GetItem dry run** (`reconcile_selling_status`): every DB price
  already matched eBay (`$X → $X` across 45 items), confirming GetItem works
  for both own and others' listings. Bid counts diverged on heavy-bid items
  (the DB count from the viewbids parse was ~15 short of eBay's badge count).
- **First `sweep_feedback` dry run, Jun 2026**: for `ryan_5050` via `UserID`,
  30 feedback entries fetched, 30 mapped — i.e. comment text + item linkage
  do come through for other users.
- **GetFeedback field set (Jun 2026)**: CommentText/Time/Type,
  CommentingUser(+Score), FeedbackID, FeedbackRatingStar, ItemID, ItemPrice,
  ItemTitle, OrderLineItemID, Role, TransactionID — no photos.

## Removed references

- Dev deploy branch `claude/ebay-auction-monitor-vdOMZ` (named as the
  development/deploy branch in the old CLAUDE.md): no longer exists on the
  remote; CI triggers on `main` + PRs.
- `~/.claude/plans/the-other-half.md`: a local planning file outside the
  repository; not present, so references to it were dropped. The decisions it
  recorded survive in `docs/other-half.md`.
- PR / phase tags in headings (PR #18, #19, #26, #27, Phase 2.5, 3, 5, 6):
  changelog noise; `git log` has the history.
