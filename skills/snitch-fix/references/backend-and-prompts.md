# Fixes outside the app: backends, prompts and models

Some reports are about what a server or a model does: wrong answers, answers that are too long or forgetful, the
wrong tool, a slow or failing request. Use the "This project" tables in SKILL.md for where those repositories are
checked out and what merging there does.

## Which layer owns it?

- **The app**, for what it sends and how it shows the answer: a missing field, a date range never passed, a reply
  built from a template that ignores the question, a response shown in the wrong place.
- **The backend**, for what it does with the request: its logic, its data, what the model is told.

Look at the request in the timeline (`get_timeline` with `kinds: ["net"]`): its path, status and timing often settle
it. A fix can need both; then each repository gets its own branch and pull request, and each names the other and
which merges first.

**Merging a backend pull request may be a production deploy.** Open it, say so in the description and the report
back, and leave the merge to the user. A pull request in another repository that fixes an issue filed here says
`Fixes <owner>/<repo>#<issue>`.

## Changing a prompt

Check the change against the real model, on the branch and on the default branch, with the same inputs.

- **Inputs:** the tester's own message (with the conversation before it, from the frames and timeline), plus two to
  four controls the change must not affect. About ten calls in all. Ask before running more: they cost money.
- **Run the backend locally with production's settings** (the same model and flags), or call the model directly with
  the prompt as the backend builds it. Don't point the app's debug build at a local server without telling the user;
  if that needs a temporary edit, revert it before committing.
- **Commit the branch before the baseline run.** `git switch` carries uncommitted edits along, so a baseline run
  after switching would quietly test the change.
- **Read the results both ways:** the tester's case fixed, and the controls unchanged (not preachy, not stiffer, the
  same facts).
- **Don't quote an example reply in a rule.** Models repeat it word for word, again and again. Describe the
  behaviour instead ("in your own words each time").
- If prompts are versioned, bump the version of each one you change. If production can override prompts (an admin
  page, a database), check whether an override would hide the change, and say so.
- Prompts mirrored in two places (a server file and a client fallback, say) change together; look for a test that
  checks they match.

## Data leaving the device

A fix that sends something new (another field, more history, a new third party) changes what the privacy policy and
any in-app disclosure promise. Update them in the same round, and say which must ship first: usually the policy,
before an app build with the change.
