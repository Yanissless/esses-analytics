# Connecting Google Analytics — step by step

**Time:** about 15 minutes. **You need:** a Google account with admin access to the Esses GA4
property.

The reason this is fiddly is that it spans **two separate Google websites** that look nothing
alike, and each one has a decoy sitting right next to the thing you actually need. This walks
through both and names the decoys.

| Where | What you get there |
|---|---|
| **console.cloud.google.com** | A service account, and a JSON key file |
| **analytics.google.com** | Permission for that account, and the Property ID |

---

# Part 1 — Google Cloud Console

Go to **console.cloud.google.com** and sign in.

## 1.1 Make a project

If you've never used Cloud Console, it'll ask you to create a project.

1. Top-left, next to the Google Cloud logo, there's a **project dropdown** (it may say
   "Select a project")
2. Click it, then **NEW PROJECT** (top right of the popup)
3. **Project name:** `esses-analytics`
4. Leave Location as-is
5. Click **CREATE** and wait ~10 seconds
6. **Make sure that project is now selected in the dropdown** before continuing. If it says
   any other name, click the dropdown and pick `esses-analytics`

Everything below has to happen inside that project. If a later step looks wrong or empty,
check the dropdown first — it's the usual cause.

## 1.2 Turn on the right API

⚠️ **This is decoy number one.** There are several similarly named Analytics APIs. You need
exactly one, and the older ones will look plausible.

1. In the search bar at the very top, type: `Google Analytics Data API`
2. In the results, click the one named **exactly** "Google Analytics Data API"
   - **NOT** "Google Analytics API" — that's the retired Universal Analytics one
   - **NOT** "Google Analytics Admin API" — different thing, we don't need it
3. Click the blue **ENABLE** button
4. Wait for it to finish (~15 seconds)

If the button says **MANAGE** instead of ENABLE, it's already on. That's fine, carry on.

## 1.3 Create the service account

A "service account" is a robot user. It's how the app reads your analytics without anyone
logging in.

1. Search bar at the top: `Service accounts`
2. Click **Service accounts** (under IAM & Admin)
3. Click **+ CREATE SERVICE ACCOUNT** near the top
4. **Service account name:** `esses-analytics-reader`
5. Click **CREATE AND CONTINUE**
6. **"Grant this service account access to project"** — skip it. Click **CONTINUE**
7. **"Grant users access to this service account"** — skip it too. Click **DONE**

You'll land back on a list with your new account in it.

## 1.4 Copy the robot's email address

You'll need this in Part 2. It looks like an email but nobody reads it.

1. In the list, find `esses-analytics-reader`
2. Its **Email** column shows something like:
   `esses-analytics-reader@esses-analytics-123456.iam.gserviceaccount.com`
3. **Copy that whole string** and paste it into Notepad for a moment

## 1.5 Download the key file

1. Click on `esses-analytics-reader` in the list to open it
2. Click the **KEYS** tab along the top
3. Click **ADD KEY** → **Create new key**
4. Choose **JSON** (it's the default)
5. Click **CREATE**

A `.json` file downloads automatically — probably to your Downloads folder, named something
like `esses-analytics-123456-a1b2c3d4.json`.

**That file is a password.** Anyone holding it can read your analytics. Don't email it, don't
put it in Slack, and don't save it inside the project folder where it could get committed to
GitHub. Leave it in Downloads for now and tell Claude the path.

---

# Part 2 — Google Analytics

Go to **analytics.google.com** and sign in.

## 2.1 Give the robot permission

1. Bottom-left corner, click the **gear icon** (⚙ Admin)
2. You'll see two columns: **Account** on the left, **Property** on the right
3. In the **Property** column, click **Property access management**
   - ⚠️ **Decoy number two:** there is also an *Account* access management in the left
     column. Wrong one. It has to be the **Property** column.
4. Top right, click the blue **+** button, then **Add users**
5. **Email addresses:** paste the robot email from step 1.4
6. **Untick** "Notify new users by email" (it's a robot, it has no inbox)
7. Under **Direct roles and data restrictions**, choose **Viewer**
   - Viewer is read-only, which is all the app needs and all it should have
8. Click **Add** (top right)

## 2.2 Find the Property ID

⚠️ **Decoy number three, and the one people get wrong most often.**

1. Still in **Admin**, in the **Property** column click **Property details**
2. Top right of that page, you'll see **PROPERTY ID** with a number under it
3. It is **9 or 10 digits**, like `485729103`
4. Copy it

**It is NOT the Measurement ID.** That's the one that starts `G-` followed by letters and
numbers, like `G-ABC1234XYZ`. The Measurement ID is for putting tracking on a website; it will
not work here and the error it produces doesn't explain why.

> If the number you copied starts with `G-`, go back — you've got the wrong one.

---

# Part 3 — Hand it over

Send Claude:

1. **The path to the JSON file**, e.g. `C:\Users\samwi\Downloads\esses-analytics-123456-a1b2c3d4.json`
2. **The Property ID** — the 9-10 digit number

Paste the *path*, not the file contents. The file is a credential; the path is not.

Claude will move it somewhere safe, add it to `.gitignore`, and wire up the connector.

---

# If something goes wrong

**"Permission denied" or "403" when the app first runs**
Almost always step 2.1 — either the robot email was added to *Account* access instead of
*Property* access, or it was added to a different property. Redo 2.1 and check the Property
column heading names the Esses website.

**"API has not been used in project ... before or it is disabled"**
Step 1.2 didn't take, or it was enabled in a different project. Check the project dropdown
matches `esses-analytics`, then redo 1.2.

**"Invalid property ID" or numbers that are all zero**
Step 2.2 — you likely have the Measurement ID (`G-...`) rather than the Property ID. They live
on different screens and only one is a plain number.

**You can't find the gear icon in Analytics**
It's the very bottom of the left-hand menu, and it's easy to miss if the window is short.
Scroll the left menu down.

---

# What this gets us, and what it doesn't

**Gets us:** traffic that never converts. Every other number in Esses Analytics comes from
orders, so we can see which article a *buyer* landed on but we are blind to an article read by
8,000 people who bought nothing. That's the "branded article performance" question, and nothing
else we have can answer it.

**Deliberately not doing:** attribution. GA4 has its own attribution model and it will disagree
with ours, with no way to adjudicate between them. Keeping one attribution system means one
answer to "where did this revenue come from". GA4 is scoped to content metrics only — sessions
and pageviews by page path.
