export interface BotTemplate {
  id: string;
  name: string;
  description: string;
  category: 'Design' | 'Engineering' | 'Executive & Admin' | 'Marketing' | 'Sales' | 'Finance' | 'Operations';
  shape: 'blob' | 'pebble' | 'squircle' | 'tablet' | 'wedge' | 'hex' | 'cloud' | 'teardrop';
  color: string;
}

export const GROK_BOT_TEMPLATES: BotTemplate[] = [
  {
    "id": "night-shift",
    "name": "Night Shift",
    "description": "Works overnight and preps your morning digest",
    "category": "Operations",
    "shape": "cloud",
    "color": "#FF309B"
  },
  {
    "id": "inbox-triage",
    "name": "Inbox Triage",
    "description": "Sorts your email and drafts replies in your voice",
    "category": "Executive & Admin",
    "shape": "blob",
    "color": "#6366F1"
  },
  {
    "id": "chief-of-staff",
    "name": "Chief of Staff",
    "description": "Manages your other Bots and pulls you in for decisions",
    "category": "Executive & Admin",
    "shape": "pebble",
    "color": "#3B82F6"
  },
  {
    "id": "negotiator",
    "name": "Negotiator",
    "description": "Researches fair pricing and haggles in your voice",
    "category": "Operations",
    "shape": "squircle",
    "color": "#10B981"
  },
  {
    "id": "prototyper",
    "name": "Prototyper",
    "description": "Turns your ideas into working prototypes",
    "category": "Design",
    "shape": "tablet",
    "color": "#F59E0B"
  },
  {
    "id": "researcher",
    "name": "Researcher",
    "description": "Digs into any question across your tools and the web",
    "category": "Operations",
    "shape": "wedge",
    "color": "#EC4899"
  },
  {
    "id": "shopper",
    "name": "Shopper",
    "description": "Gathers quotes and options into a clear comparison",
    "category": "Operations",
    "shape": "hex",
    "color": "#8B5CF6"
  },
  {
    "id": "apartment-scout",
    "name": "Apartment Scout",
    "description": "Shortlists listings the moment they drop and books tours",
    "category": "Finance",
    "shape": "teardrop",
    "color": "#06B6D4"
  },
  {
    "id": "lookout",
    "name": "Lookout",
    "description": "Watches any site and alerts you to changes",
    "category": "Operations",
    "shape": "cloud",
    "color": "#EF4444"
  },
  {
    "id": "competitor-watcher",
    "name": "Competitor Watcher",
    "description": "Tracks competitor pricing and launches, and briefs you weekly",
    "category": "Operations",
    "shape": "blob",
    "color": "#14B8A6"
  },
  {
    "id": "crm-scribe",
    "name": "CRM Scribe",
    "description": "Turns your calls into CRM updates and follow-ups",
    "category": "Sales",
    "shape": "pebble",
    "color": "#FF309B"
  },
  {
    "id": "pipeline-scout",
    "name": "Pipeline Scout",
    "description": "Researches target accounts and builds your attack plan",
    "category": "Operations",
    "shape": "squircle",
    "color": "#6366F1"
  },
  {
    "id": "first-responder",
    "name": "First Responder",
    "description": "Answers new leads in minutes and books the meeting in your calendar",
    "category": "Sales",
    "shape": "tablet",
    "color": "#3B82F6"
  },
  {
    "id": "win-loss-analyst",
    "name": "Win-Loss Analyst",
    "description": "Reads every lost deal and reports why you're really losing",
    "category": "Operations",
    "shape": "wedge",
    "color": "#10B981"
  },
  {
    "id": "icebreaker",
    "name": "Icebreaker",
    "description": "Watches for launches and hires worth a warm intro",
    "category": "Operations",
    "shape": "hex",
    "color": "#F59E0B"
  },
  {
    "id": "call-coach",
    "name": "Call Coach",
    "description": "Rewatches your calls and gives specific coaching",
    "category": "Operations",
    "shape": "teardrop",
    "color": "#EC4899"
  },
  {
    "id": "deck-designer",
    "name": "Deck Designer",
    "description": "Turns your notes into an on-brand presentation deck",
    "category": "Design",
    "shape": "cloud",
    "color": "#8B5CF6"
  },
  {
    "id": "channel-digest",
    "name": "Channel Digest",
    "description": "Summarizes your chat channels and flags what needs you",
    "category": "Operations",
    "shape": "blob",
    "color": "#06B6D4"
  },
  {
    "id": "ticket-triager",
    "name": "Ticket Triager",
    "description": "Triages everything new in support and drafts the first reply",
    "category": "Operations",
    "shape": "pebble",
    "color": "#EF4444"
  },
  {
    "id": "feedback-miner",
    "name": "Feedback Miner",
    "description": "Clusters your customer feedback into clear themes",
    "category": "Operations",
    "shape": "squircle",
    "color": "#14B8A6"
  },
  {
    "id": "review-responder",
    "name": "Review Responder",
    "description": "Drafts on-brand replies to reviews and messages",
    "category": "Marketing",
    "shape": "tablet",
    "color": "#FF309B"
  },
  {
    "id": "marketing-analyst",
    "name": "Marketing Analyst",
    "description": "Reports on campaign performance and where to spend next",
    "category": "Marketing",
    "shape": "wedge",
    "color": "#6366F1"
  },
  {
    "id": "shopkeeper",
    "name": "Shopkeeper",
    "description": "Watches orders and payouts in your store and flags anything odd",
    "category": "Operations",
    "shape": "hex",
    "color": "#3B82F6"
  },
  {
    "id": "invoice-chaser",
    "name": "Invoice Chaser",
    "description": "Tracks unpaid invoices and drafts the reminders",
    "category": "Finance",
    "shape": "teardrop",
    "color": "#10B981"
  },
  {
    "id": "expense-auditor",
    "name": "Expense Auditor",
    "description": "Files receipts daily and categorizes every charge",
    "category": "Finance",
    "shape": "cloud",
    "color": "#F59E0B"
  },
  {
    "id": "subscription-sleuth",
    "name": "Subscription Sleuth",
    "description": "Finds subscriptions you no longer use across your spend",
    "category": "Operations",
    "shape": "blob",
    "color": "#EC4899"
  },
  {
    "id": "paralegal",
    "name": "Paralegal",
    "description": "Reviews contracts and drafts redlines for approval",
    "category": "Operations",
    "shape": "pebble",
    "color": "#8B5CF6"
  },
  {
    "id": "application-screener",
    "name": "Application Screener",
    "description": "Screens new applications and surfaces the top candidates",
    "category": "Design",
    "shape": "squircle",
    "color": "#06B6D4"
  },
  {
    "id": "sourcing-scout",
    "name": "Sourcing Scout",
    "description": "Delivers qualified profiles matched to open roles",
    "category": "Operations",
    "shape": "tablet",
    "color": "#EF4444"
  },
  {
    "id": "qa-engineer",
    "name": "QA Engineer",
    "description": "Clicks through every new deploy and reports what breaks",
    "category": "Operations",
    "shape": "wedge",
    "color": "#14B8A6"
  },
  {
    "id": "dashboard-watcher",
    "name": "Dashboard Watcher",
    "description": "Watches your metrics and alerts you on anomalies",
    "category": "Operations",
    "shape": "hex",
    "color": "#FF309B"
  },
  {
    "id": "data-scientist",
    "name": "Data Scientist",
    "description": "Answers data questions with real database queries and charts",
    "category": "Operations",
    "shape": "teardrop",
    "color": "#6366F1"
  },
  {
    "id": "bug-reproduction",
    "name": "Bug Reproduction",
    "description": "Repros the bug in staging and drops a pack with steps and screenshots",
    "category": "Design",
    "shape": "cloud",
    "color": "#3B82F6"
  },
  {
    "id": "product-performance",
    "name": "Product Performance",
    "description": "Walks observability tools and writes up the hotspots",
    "category": "Operations",
    "shape": "blob",
    "color": "#10B981"
  },
  {
    "id": "cloud-agent-orchestrator",
    "name": "Cloud Agent Orchestrator",
    "description": "Kicks off cloud agent runs, chases what's stuck, and summarizes",
    "category": "Operations",
    "shape": "pebble",
    "color": "#F59E0B"
  },
  {
    "id": "playtest-operator",
    "name": "Playtest Operator",
    "description": "Drives the product UI and returns a tight findings pack",
    "category": "Design",
    "shape": "squircle",
    "color": "#EC4899"
  },
  {
    "id": "prototype-builder",
    "name": "Prototype Builder",
    "description": "Writes on its computer and comes back with a screenshot and a live URL",
    "category": "Design",
    "shape": "tablet",
    "color": "#8B5CF6"
  },
  {
    "id": "figma-bot",
    "name": "Figma Bot",
    "description": "Handles repetitive Figma work while keeping layouts and variants consistent",
    "category": "Design",
    "shape": "wedge",
    "color": "#06B6D4"
  },
  {
    "id": "motion-help",
    "name": "Motion Help",
    "description": "Builds a playground around real assets to tune motion and interactions",
    "category": "Design",
    "shape": "hex",
    "color": "#EF4444"
  },
  {
    "id": "design-exploration",
    "name": "Design Exploration",
    "description": "Turns loose ideas into prototypes of varying fidelities you can try",
    "category": "Design",
    "shape": "teardrop",
    "color": "#14B8A6"
  },
  {
    "id": "devbot",
    "name": "Devbot",
    "description": "Answers engineering questions and helps other Bots understand implementation",
    "category": "Engineering",
    "shape": "cloud",
    "color": "#FF309B"
  },
  {
    "id": "paid-media",
    "name": "Paid Media",
    "description": "Pulls campaign data and recommends a budget reallocation for your approval",
    "category": "Operations",
    "shape": "blob",
    "color": "#6366F1"
  },
  {
    "id": "competitive-intelligence",
    "name": "Competitive Intelligence Analyst",
    "description": "Monitors launches overnight and flags messaging that needs a refresh",
    "category": "Operations",
    "shape": "pebble",
    "color": "#3B82F6"
  },
  {
    "id": "newsletter-writer",
    "name": "Newsletter Writer",
    "description": "Pulls what's new and drafts the issue in your voice for review",
    "category": "Operations",
    "shape": "squircle",
    "color": "#10B981"
  },
  {
    "id": "social-media-manager",
    "name": "Social Media Manager",
    "description": "Drafts posts in your voice when something noteworthy ships",
    "category": "Marketing",
    "shape": "tablet",
    "color": "#F59E0B"
  },
  {
    "id": "seo-aeo-auditor",
    "name": "SEO / AEO Auditor",
    "description": "Tracks keyword and competitor movement and returns an optimization plan",
    "category": "Operations",
    "shape": "wedge",
    "color": "#EC4899"
  },
  {
    "id": "account-health",
    "name": "Account Health",
    "description": "Reads usage and signals across your book and turns them into a watch list",
    "category": "Finance",
    "shape": "hex",
    "color": "#8B5CF6"
  },
  {
    "id": "account-manager",
    "name": "Account Manager",
    "description": "Preps every call from transcripts, CRM, and Slack, then drafts follow-ups",
    "category": "Sales",
    "shape": "teardrop",
    "color": "#06B6D4"
  },
  {
    "id": "enablement-fulfillment",
    "name": "Enablement Fulfillment Specialist",
    "description": "Finds the recordings, builds the one-pager, and drafts the reply",
    "category": "Design",
    "shape": "cloud",
    "color": "#EF4444"
  },
  {
    "id": "ticket-triage",
    "name": "Ticket Triage Specialist",
    "description": "Watches the support queue, drafts replies, and stays quiet when it's clean",
    "category": "Design",
    "shape": "blob",
    "color": "#14B8A6"
  },
  {
    "id": "beta-adoption-watcher",
    "name": "Beta Adoption Watcher",
    "description": "Monitors usage and surfaces which customers are trying the new feature",
    "category": "Operations",
    "shape": "pebble",
    "color": "#FF309B"
  },
  {
    "id": "call-faq-miner",
    "name": "Call FAQ Miner",
    "description": "Tracks questions from calls and links each answer back to the recording",
    "category": "Operations",
    "shape": "squircle",
    "color": "#6366F1"
  },
  {
    "id": "docs-auditor",
    "name": "Docs Auditor",
    "description": "Diffs help center pages against what shipped and drafts the rewrite",
    "category": "Operations",
    "shape": "tablet",
    "color": "#3B82F6"
  },
  {
    "id": "feature-request-tracker",
    "name": "Feature Request Tracker",
    "description": "Mines Slack and calls into a living list tied to customers",
    "category": "Operations",
    "shape": "wedge",
    "color": "#10B981"
  },
  {
    "id": "product-feedback-analyst",
    "name": "Product Feedback Analyst",
    "description": "Clusters feedback, weighs urgency, and drafts routing for approval",
    "category": "Operations",
    "shape": "hex",
    "color": "#F59E0B"
  },
  {
    "id": "expense-manager",
    "name": "Expense Manager",
    "description": "Builds the weekly spend summary, logs receipts, and nudges missing categories",
    "category": "Design",
    "shape": "teardrop",
    "color": "#EC4899"
  },
  {
    "id": "contract-desk",
    "name": "Contract Desk",
    "description": "Summarizes the week's paper by stage and owner and flags blocked reviews",
    "category": "Operations",
    "shape": "cloud",
    "color": "#8B5CF6"
  },
  {
    "id": "invoice-coordinator",
    "name": "Invoice Coordinator",
    "description": "Forwards invoices, matches what it can, and nudges the owner when stuck",
    "category": "Finance",
    "shape": "blob",
    "color": "#06B6D4"
  },
  {
    "id": "security-questionnaire",
    "name": "Security Questionnaire Filler",
    "description": "Drafts vendor security answers from your trust center and past RFPs",
    "category": "Operations",
    "shape": "pebble",
    "color": "#EF4444"
  },
  {
    "id": "vendor-portal-operator",
    "name": "Vendor Portal Operator",
    "description": "Runs renewals and seats on portals with no API and returns exceptions",
    "category": "Engineering",
    "shape": "squircle",
    "color": "#14B8A6"
  },
  {
    "id": "talent-scout",
    "name": "Talent Scout",
    "description": "Sources candidates, drafts outreach in your voice, and skips people already in the ATS",
    "category": "Operations",
    "shape": "tablet",
    "color": "#FF309B"
  },
  {
    "id": "calendar-coordinator",
    "name": "Calendar Coordinator",
    "description": "Schedules across calendars and chases the holds nobody else has time for",
    "category": "Executive & Admin",
    "shape": "wedge",
    "color": "#6366F1"
  },
  {
    "id": "hiring-screener",
    "name": "Hiring Screener",
    "description": "Scores applications against a defined bar and hands off an ATS-ready review",
    "category": "Design",
    "shape": "hex",
    "color": "#3B82F6"
  },
  {
    "id": "onboarding-manager",
    "name": "Onboarding Manager",
    "description": "Builds the new-hire checklist, pulls the docs, and routes day-one questions",
    "category": "Design",
    "shape": "teardrop",
    "color": "#10B981"
  },
  {
    "id": "sales-outbound",
    "name": "Sales Outbound",
    "description": "Researches accounts overnight, drafts outreach in your voice, and leaves a review list",
    "category": "Sales",
    "shape": "cloud",
    "color": "#F59E0B"
  },
  {
    "id": "account-research",
    "name": "Account Research Specialist",
    "description": "Pulls CRM plus live signals and builds a shareable research pack per account",
    "category": "Design",
    "shape": "blob",
    "color": "#EC4899"
  },
  {
    "id": "meeting-prep",
    "name": "Meeting Prep Buddy",
    "description": "Builds a prep pack from calendar, CRM, and Slack before every meeting",
    "category": "Design",
    "shape": "pebble",
    "color": "#8B5CF6"
  },
  {
    "id": "pipeline-analyst",
    "name": "Pipeline Analyst",
    "description": "Scrubs the pipeline, flags stalls and commit risk, and drops a Monday scoreboard",
    "category": "Operations",
    "shape": "squircle",
    "color": "#06B6D4"
  },
  {
    "id": "sales-call-coach",
    "name": "Sales Call Coach",
    "description": "Reviews calls and leaves timestamped coaching on discovery and objections",
    "category": "Sales",
    "shape": "tablet",
    "color": "#EF4444"
  },
  {
    "id": "chief-of-staff-readout",
    "name": "Chief of Staff",
    "description": "Scans Slack, email, and calendar and delivers a readout on what needs you",
    "category": "Executive & Admin",
    "shape": "wedge",
    "color": "#14B8A6"
  },
  {
    "id": "daily-briefing-writer",
    "name": "Daily Briefing Writer",
    "description": "Delivers a tight daily brief of only the stories that matter to you",
    "category": "Operations",
    "shape": "hex",
    "color": "#FF309B"
  },
  {
    "id": "executive-assistant",
    "name": "Executive Assistant",
    "description": "Delivers a morning briefing and a catch-up summary when you join a new room",
    "category": "Executive & Admin",
    "shape": "teardrop",
    "color": "#6366F1"
  },
  {
    "id": "inbox-manager",
    "name": "Inbox Manager",
    "description": "Triages email, surfaces urgent threads, and drafts replies for your approval",
    "category": "Executive & Admin",
    "shape": "cloud",
    "color": "#3B82F6"
  },
  {
    "id": "presentation-designer",
    "name": "Presentation Designer",
    "description": "Builds an on-brand deck from your notes and leaves an editable link",
    "category": "Design",
    "shape": "blob",
    "color": "#10B981"
  }
];
