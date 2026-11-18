# Recurring posts

A recurring post (a series) publishes the same content on a schedule. Create it by passing `recurrence` to
`create_post`; no other tool takes `recurrence`. Pass the same `workspaceId` on every call about a series.

## Creating one

```json
{
  "platforms": ["LINKEDIN"],
  "contentType": "TEXT",
  "text": "{Hi|Hello} everyone, here is this week's tip",
  "timezone": "Europe/Berlin",
  "linkedinConnectionIds": ["<id from list_accounts>"],
  "scheduledAt": "2026-10-05T07:00:00Z",
  "recurrence": {
    "frequency": "WEEKLY",
    "interval": 1,
    "weekdays": ["MONDAY", "THURSDAY"],
    "maxOccurrences": 10
  }
}
```

| Field | Rule |
|-------|------|
| `frequency` | Required. `DAILY`, `WEEKLY`, `MONTHLY` or `YEARLY` (same date each year; a series started on February 29 posts on February 28 in other years) |
| `interval` | Every N days, weeks, months or years, 1 to 30 (default 1) |
| `weekdays` | `WEEKLY` only, `MONDAY` to `SUNDAY`. The weekday of `scheduledAt` is always included |
| `endsOn` | `YYYY-MM-DD`, the last day an occurrence may go out (inclusive). On or after the first post's day |
| `maxOccurrences` | Total posts the series publishes, 2 to 365 |

- `scheduledAt` must be in the future. That post is the first occurrence and sets the time of day, read in
  `timezone`.
- `endsOn` and `maxOccurrences` cannot be combined. With neither, the series repeats until paused or
  deleted.
- The call fails with `saveAsDraft: true`, with a past or missing `scheduledAt`, with both end fields, with
  an `endsOn` before the first post, with `TIKTOK` in `platforms`, or with YouTube's `scheduleOnYouTube`.
- X and LinkedIn reject identical text. Put spintax such as `{Hi|Hello}` in the text so each post differs.
- Before creating it, show the content, accounts, frequency, first date and time with timezone, and when it
  ends. Get an explicit "yes".

The response adds `recurringPostId`; `postId` is the first occurrence. Only the next occurrence of an
ACTIVE series exists as a SCHEDULED post, created about 24 hours ahead. Every post carries
`recurringPostId` (or null) and `occurrenceAt`, the slot it fills.

## Managing a series

| Want | Tool | Effect |
|------|------|--------|
| See all series | `list_recurring_posts` | Filter by `statuses` (`ACTIVE`, `PAUSED`, `ENDED`); page with `offset` while `hasMore` is true |
| One series, or why it paused | `get_recurring_post` | Returns `status`, `pauseReason`, `lastError`, the schedule, `nextOccurrenceAt`, `occurrenceCount` |
| Hold it | `pause_recurring_post` | Stops new occurrences and deletes the upcoming scheduled post |
| Continue | `resume_recurring_post` | Continues from the next occurrence after now; comes back ENDED if no slot is left |
| Stop for good | `delete_recurring_post` | Deletes the series and its upcoming scheduled post. Published posts stay |
| Skip one date | `delete_post` on that occurrence | The series continues |

- Slots that pass while a series is paused are skipped, never published late.
- A series pauses itself after 3 failed posts in a row, when the subscription lapses, when its creator loses
  workspace access, when one of its accounts is disconnected, or when a network rejects the content.
  `pauseReason` says which: `USER`, `CONSECUTIVE_FAILURES`, `SUBSCRIPTION_INACTIVE`, `ACCESS_LOST`,
  `CONNECTION_REMOVED` or `INVALID_CONTENT`. Fix the cause before resuming, or it pauses again.
- Resuming starts publishing again with nobody watching, so confirm with the user first. Confirm a delete
  too; prefer pause when the user may want the series back.
- Editing a series is only possible in the AdaptlyPost app.
