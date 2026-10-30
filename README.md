# Shot Planner

A shared, live choreography board for a single-take shoot: who stands where, when they move, what the camera sees, the
swap windows, the cards, the run sheet and the resets. Everyone with the team's link edits the same plan, and every
change shows up for everyone within a second or two.

## How it works

- The page is static (GitHub Pages). The plan itself lives in a Firestore database, never in this repository.
- The team's link ends with `#` and a key. The part after `#` never leaves the browser except to the database, and the
  database rules only open the one plan whose key matches. No key, no plan.
- Every change is a small field edit with the editor's name on it, so two people working at once don't overwrite each
  other. The History tab lists every change and can undo any of them; an hourly copy of the whole plan can be restored.
- The board (positions over time, the camera's view, swap windows, cards, checks) is worked out in the browser from the
  plan's rows (`derive.js`), the same rules as the Python build it replaced.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css` | The page |
| `app.js` | The board and the editor |
| `derive.js`, `worker.js` | Works out the board from the plan (in a background worker) |
| `store.js` | Firestore sync, history, hourly copies, who's here |
| `firebase-config.js` | Which Firebase project holds the plan (not secret: the rules decide access) |

Open the page with `?local` to try it with a copy that stays in your own browser.
