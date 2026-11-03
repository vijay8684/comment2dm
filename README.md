# Comment2DM (formerly Nudge) — AI & Developer Handoff Document

> **Comprehensive System Documentation, Architecture Guide, and Action Plan for Autonomous AI Agents & Software Engineers.**

---

## 📌 Executive Summary & Project Purpose

**Comment2DM** is a high-performance **Instagram Growth & Marketing Automation SaaS**. 

### The Core Purpose
When a follower or viewer comments on an influencer's/creator's Instagram Reel or Post:
1. **Private Direct Message (DM)**: The system instantly delivers a private message to the commenter's Instagram inbox with a requested resource (download link, product coupon, PDF, pricing, or checkout link).
2. **Public Comment Reply**: The system immediately leaves a public reply in the comment thread confirming delivery (e.g., *"Sent to your DM! Check inbox 📩"*), which boosts Instagram algorithmic engagement.

---

## 🔗 Critical Links, Credentials & Infrastructure

| Resource | Value / URL |
| :--- | :--- |
| **Brand Name** | **Comment2DM** (previously called *Nudge*) |
| **GitHub Repository** | [`https://github.com/Jayvardhanreddy/Nudge.git`](https://github.com/Jayvardhanreddy/Nudge.git) |
| **Active Git Branch** | `main` |
| **Render Webhook Deploy URL** | `https://api.render.com/deploy/srv-dam2qnu7bikc73846q8g?key=sAMphGDO8Vs` |
| **Live Production Site** | [`https://nudge-dto0.onrender.com`](https://nudge-dto0.onrender.com) |
| **Meta Webhook Callback URL** | `https://nudge-dto0.onrender.com/api/instagram/webhook` |
| **Meta OAuth Redirect URI** | `https://nudge-dto0.onrender.com/api/instagram/callback` |
| **Webhook Verify Token** | `comment2dm_webhook_token` |
| **Admin Superuser Email** | `jayvardhanreddy2008@gmail.com` |
| **Live Backend Diagnostic URL** | [`https://nudge-dto0.onrender.com/api/instagram/debug-status`](https://nudge-dto0.onrender.com/api/instagram/debug-status) |

---

## 🛠️ Complete Tech Stack

- **Frontend**:
  - Pure Vanilla HTML5, CSS3, and Modular ES6+ JavaScript.
  - **Design System**: Apple Human Interface Guidelines (HIG) Dark Theme.
    - Deep obsidian background: `#09090b`
    - Frosted glass cards: `rgba(255, 255, 255, 0.03)` with `rgba(255, 255, 255, 0.08)` borders
    - Indigo accent gradient: `#6366f1` / `#818cf8`
    - Typography: Inter font (`https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap`)
  - **Zero Heavy Frameworks**: No React/Vue/Next.js overhead to ensure instantaneous loading on low-bandwidth mobile devices.
  - **Interactive iPhone Simulator**: Real-time simulated Instagram Reel & DM inbox preview on the automations page.
- **Backend**:
  - **Runtime**: Node.js (v18+) with Express.js (`v5.2.1`).
  - **Authentication**: Bcrypt (salt rounds: 12) + HttpOnly secure session cookies (`comment2dm_session`) + JWT fallback tokens (`nudge_token`).
  - **Token Encryption**: AES-256-GCM symmetric encryption for all stored Meta Long-Lived User Access Tokens via `META_TOKEN_ENCRYPTION_KEY`.
- **Database & Emulation Layer**:
  - **MongoDB Atlas** (Free Tier M0 cluster).
  - **SQLite-to-MongoDB Emulation Layer (`src/db.js`)**:
    > ⚠️ **CRITICAL ARCHITECTURAL WARNING FOR NEXT DEVELOPER/AI**:
    > The legacy backend originally executed SQLite queries (`db.get`, `db.run`, `db.all`). To prevent breaking existing SQL queries while migrating to MongoDB Atlas, `src/db.js` serves as an intelligent SQL-to-MongoDB translation engine. It parses SQL syntax with regex and translates queries directly into MongoDB collection commands. **Do NOT delete or bypass `src/db.js` without rewriting all queries in `server.js`!**
  - **Free Tier Space Optimization**: Built-in MongoDB TTL (Time-To-Live) indexes automatically purge processed webhook deduplication events after 7 days and activity logs after 30 days to strictly stay within the 512MB free storage boundary.
- **Payment & Subscriptions**:
  - **Razorpay Subscriptions**: Native recurring plans (Free: 300 DMs/mo, Pro: ₹999/mo, Elite: ₹2499/mo).
- **Deployment Platform**:
  - **Render.com** (Free Web Service tier, auto-deploying from `main` or via Render Deploy Hook).

---

## 📂 Annotated File Structure

```text
Nudge/
├── .env.example               # Template for environment variables
├── .gitignore                 # Standard node_modules & secret ignore rules
├── package.json               # Node.js dependencies (express, mongodb, razorpay, bcrypt, etc.)
├── server.js                  # Primary backend server (Express routing, auth, webhooks, API)
├── styles.css                 # Master Apple HIG dark theme stylesheets & CSS variables
├── fix-nav.js                 # Helper script ensuring UTF-8 encoding across HTML files
│
├── src/                       # Core backend services & engines
│   ├── db.js                  # MongoDB connection & SQL-to-Mongo translation engine
│   ├── billing.js             # Razorpay recurring subscription & pricing logic
│   ├── auth/
│   │   └── authService.js     # User registration, password hashing, and session management
│   └── instagram/
│       └── instagramService.js# Meta Graph API v21.0 integration (OAuth, Reels, DMs, Replies)
│
├── Root Application Pages (HTML & JS Pairs):
│   ├── index.html             # High-conversion Apple-style SaaS landing page & pricing cards
│   ├── login.html             # Multi-tab authentication (Login / Signup) with validation
│   ├── dashboard.html         # Main overview dashboard with live metrics & quick actions
│   ├── dashboard.js           # Shared app shell logic (nav highlighting, user profile, quota gauge)
│   ├── instagram-accounts.html# Connected Instagram accounts manager (connect, disconnect, status)
│   ├── automations.html       # Comment-to-DM workflow builder with visual Reel picker & live iPhone preview
│   ├── automations.js         # Automations state controller (Reel fetching, keyword matching, CRUD)
│   ├── creator-tools.html     # Creator Studio AI tools (caption generator, hook writer, hashtag analyzer)
│   ├── creator-tools.js       # Client logic for AI tool generation
│   ├── analytics.html         # Growth charts, DM delivery rate, and engagement analytics
│   ├── analytics.js           # Analytics chart rendering & event aggregations
│   ├── messages.html          # Detailed DM Log table (timestamps, statuses, recipient handles)
│   ├── messages.js            # DM activity log fetcher with pagination & status filters
│   ├── settings.html          # Profile settings, password management, and account deletion
│   ├── settings.js            # Settings form submission controller
│   ├── admin.html             # Secret Admin panel (visible only to jayvardhanreddy2008@gmail.com)
│   ├── admin.js               # Admin metrics, user list, plan management, and coupon generator
│   ├── billing.html           # Plan upgrade & checkout modal (Razorpay integration)
│   ├── billing.js             # Frontend checkout triggers for subscriptions
│   ├── pricing.html           # Public pricing page with feature comparison table
│   ├── help.html & help.js    # Interactive Help Desk, searchable FAQ, and support ticketing
│   ├── contact.html           # Contact form saving directly into MongoDB
│   ├── terms.html             # Terms of Service
│   ├── privacy.html           # Meta-compliant Privacy Policy
│   ├── refund.html            # Cancellation and refund policy
│   └── 404.html               # Custom branded 404 error page
│
└── Assets & Metadata:
    ├── favicon.svg            # SVG Brand favicon (⚡)
    ├── logo.svg               # Vector brand logo
    ├── og-image.svg           # Social preview card
    ├── robots.txt             # SEO crawler rules
    ├── sitemap.xml            # Sitemap for Google indexing
    └── security.txt           # Responsible disclosure policy
```

---

## 🚀 Accomplished Milestones

1. **Brand & Visual Redesign**:
   - Transformed the original prototype into the **Comment2DM** brand.
   - Built an Apple HIG-compliant Dark Theme with unified glass cards, custom scrollbars, and fluid responsive layouts across mobile, tablet, and desktop.
   - Restored and protected UTF-8 character encoding for all icons and emojis.
2. **Dynamic UI Shell & Sidebar**:
   - Implemented dynamic navigation active-state detection in `dashboard.js`.
   - Collapsible sidebar with real-time DM quota indicator and circular pie gauge.
   - Header profile menu with automatic user avatar generation and role badges.
3. **Automations Builder with Live iPhone Simulator**:
   - Visual Reel & Post picker that queries the Meta Graph API and displays reel thumbnails, video badges, and live comment counts.
   - Permalinks dynamically linked to view reels directly on Instagram (`🔗 View on Instagram ↗`).
   - Radio toggle between *Specific Keyword* and *Any Comment (All)*.
   - Live interactive iPhone simulator dynamically updates comment bubbles, public reply previews, and direct messages as the user types.
   - Permanent delete & edit state handling in `automations.js` (eliminating ghost/resurrected automations).
4. **Database Architecture & Reliability**:
   - Connected MongoDB Atlas with automatic fallback handling across string IDs, numeric Instagram user IDs, and Mongo `ObjectId`s.
   - Automated TTL indexes keeping storage well within the free tier.
5. **Secure Authentication & Admin Controls**:
   - Email/password authentication with Bcrypt hashing and secure sessions.
   - Role-based Admin Dashboard locked strictly to `jayvardhanreddy2008@gmail.com` via backend middleware (`requireAdmin`).
6. **Billing & Subscriptions**:
   - Razorpay recurring subscriptions integrated at `/api/billing/create-subscription`.
7. **Diagnostic & Debugging Telemetry**:
   - Built a live debugging endpoint (`/api/instagram/debug-status`) that reports connected accounts, token expiration dates, active automations, and raw webhook payloads.

---

## ⚠️ The Current Problem: Why Automated DMs Are Not Firing

The user has connected an Instagram account, created an automation for a specific reel/keyword, and posted a test comment from another Instagram account, but **no DM was received**.

### Root Cause Analysis & Diagnostic Checklist

There are **three distinct layers** where an Instagram Comment-to-DM workflow can fail:

```
[User Comments on Reel]
        │
        ▼ (Layer 1: Meta Developer Platform)
[Meta Webhook Triggered?] ─── NO ───► Check App Mode, Webhook URL, or Permissions
        │ YES
        ▼ (Layer 2: Render Server & Webhook Verification)
[Render Receives POST /api/instagram/webhook?] ─── NO ───► Check Cold-Start Timeout or URL Typos
        │ YES
        ▼ (Layer 3: Meta Graph API Message Delivery)
[POST /messages to Commenter Inbox] ─── NO ───► Check "Allow Access to Messages" Toggle or API Version
        │ YES
[DM Delivered to User Inbox! 📩]
```

### 1. Layer 1: Meta Developer Platform Configuration
- **App Type Must Be "Business"**: If the Meta App was created as "Consumer" or "Other", Instagram Graph API features will not trigger private replies.
- **App Mode (Development vs. Live)**:
  - When a Meta App is in **Development Mode**, Meta **strictly refuses to dispatch webhooks** or allow DM replies to any account that is NOT an authorized tester.
  - *Fix*: The account writing the test comment must be added under **App Roles > Roles > Instagram Testers** in the Meta Developer Console, and that account must accept the invitation inside the Instagram mobile app (`Settings > Apps and Websites > Tester Invites`).
- **Webhook Subscriptions**:
  - The webhook callback must be verified with URL: `https://nudge-dto0.onrender.com/api/instagram/webhook`
  - Verify Token: `comment2dm_webhook_token`
  - Both **`comments`** and **`messages`** fields must be checked as **Subscribed**.

### 2. Layer 2: Render Server & Endpoint Verification
- **Cold-Start Latency**: Render's free tier spins down after 15 minutes of inactivity. When a comment is posted, Render can take 40–50 seconds to boot up. In some cases, Meta's webhook delivery may timeout on the initial cold start.
  - *Fix*: Use a free monitoring service (e.g., UptimeRobot) to ping `https://nudge-dto0.onrender.com/api/me` every 5 minutes to keep the instance warm.
- **Incoming Log Verification**:
  - Check Render's server logs for the line:
    `Incoming Meta Webhook received: {"object":"instagram","entry":[...]}`
  - If this log line never appears after commenting, Meta did not dispatch the webhook.

### 3. Layer 3: Instagram Account & Message Permission
- **"Allow Access to Messages" Setting in Mobile App**:
  - On the creator/business Instagram account that owns the Reel:
  - Open the Instagram Mobile App ➔ **Settings and Privacy** ➔ **Messages and story replies** ➔ **Message controls** ➔ **Connected tools**.
  - **"Allow access to messages" must be toggled ON (Blue).**
  - If this setting is disabled, Meta's API silently rejects the `sendPrivateReply` call with an OAuth exception.
- **Meta Graph API Version**:
  - Standardized to `v21.0` in `src/instagram/instagramService.js`.
  - The service attempts `https://graph.instagram.com/v21.0/{id}/messages`, falling back to `https://graph.facebook.com/v21.0/{id}/messages`, and then `/me/messages`.

---

## 📋 Step-by-Step Instructions for the Next AI / Developer

If you are continuing this task, follow this exact sequence:

### Step 1: Inspect Live Telemetry
1. Log in to the application at `https://nudge-dto0.onrender.com/login.html`.
2. Open `https://nudge-dto0.onrender.com/api/instagram/debug-status` in your browser.
3. Review the returned JSON:
   - `accounts`: Is the Instagram account listed? Is `tokenValid` true?
   - `automations`: Is `enabled: true` or `enabled: 1`? Does the keyword match your test comment?
   - `recentWebhooksReceived`: Did any webhook reach the server?
   - `recentAutomationReplies`: If an attempt was made, what error did Meta return?

### Step 2: Test the Webhook Endpoint Manually
You can simulate Meta's exact comment webhook using `curl` against the live backend to verify that message routing executes properly:

```bash
curl -X POST "https://nudge-dto0.onrender.com/api/instagram/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "object": "instagram",
    "entry": [{
      "id": "<TARGET_INSTAGRAM_USER_ID>",
      "time": 1727360000,
      "changes": [{
        "field": "comments",
        "value": {
          "id": "test_comment_12345",
          "text": "LINK",
          "media": {
            "id": "<TARGET_MEDIA_ID>"
          }
        }
      }]
    }]
  }'
```

Check the Render server logs to observe:
`Matched automation <id> for comment "LINK"... Sending replies...`

### Step 3: Verify Environment Variables in Render
Ensure the following variables are configured in Render's **Environment** tab:

```env
PORT=3000
NODE_ENV=production
ADMIN_EMAIL=jayvardhanreddy2008@gmail.com
JWT_SECRET=<secure_random_string>
META_APP_ID=<new_meta_app_id>
META_APP_SECRET=<new_meta_app_secret>
META_REDIRECT_URI=https://nudge-dto0.onrender.com/api/instagram/callback
META_API_VERSION=v21.0
META_TOKEN_ENCRYPTION_KEY=<64_hex_character_key>
META_WEBHOOK_VERIFY_TOKEN=comment2dm_webhook_token
MONGODB_URI=mongodb+srv://...
MONGODB_DB_NAME=nudge
RAZORPAY_KEY_ID=<your_razorpay_id>
RAZORPAY_KEY_SECRET=<your_razorpay_secret>
```

### Step 4: Making Git & Deployment Changes
All commits pushed to the `main` branch of `https://github.com/Jayvardhanreddy/Nudge.git` trigger an automated build on Render.
Alternatively, trigger a deployment immediately via webhook:

```bash
curl "https://api.render.com/deploy/srv-dam2qnu7bikc73846q8g?key=sAMphGDO8Vs"
```

---

*This document was generated for Comment2DM. Maintained by the Antigravity Agentic Engineering Team.*
