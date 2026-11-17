// The fixed lists used by both the backend (validation) and the frontend (dropdowns).
// To add a module or a team member, edit this file and restart the app.

const APP_NAME = 'ERP Rebuild Task Tracker';

const TEAM = ['Thameem', 'Parimitha', 'Mausooq', 'Rashneema'];

// The modules of our ERP, named exactly as they appear in the ERP menu.
// This tracker only manages the work of rebuilding them; it does not implement them.
const ERP_MODULES = [
  'CRM',
  'Forwarding',
  'Transport (By Land)',
  'Customs',
  'NVOCC (Liner)',
  'Trading & Service',
  'Warehouse (Advance)',
  'Warehouse (Basic)',
  'Pricing',
  'Financials',
  'MIS',
  'Business Intelligence',
  'Credit Control',
  'Purchase',
  'Tracking',
  'AWB Stock'
];

// Categories for work that spans several modules.
const CROSS_MODULE_CATEGORIES = [
  'General / Cross-module',
  'Documents & OCR',
  'Integrations & APIs',
  'Deployment & Infrastructure'
];

// Every value that can be chosen for a task's "module" field.
// Tasks saved under an older name keep that name until someone maps or reassigns them
// (see "Older module names" in the README). Nothing here assigns a module to a person.
const MODULES = [...ERP_MODULES, ...CROSS_MODULE_CATEGORIES];

const PRIORITIES = ['Low', 'Medium', 'High'];
const STATUSES = ['To Do', 'In Progress', 'Blocked', 'Completed'];

// Defaults for new tasks and for tasks imported from the old tasks.json file.
const DEFAULTS = { module: 'General / Cross-module', priority: 'Medium', status: 'To Do', assignee: null };

// Length limits (characters) enforced by the server.
const LIMITS = { title: 150, description: 4000, comment: 2000, search: 100 };

// Used in filters to mean "tasks with no assignee".
const UNASSIGNED = 'Unassigned';

module.exports = { APP_NAME, TEAM, ERP_MODULES, CROSS_MODULE_CATEGORIES, MODULES, PRIORITIES, STATUSES, DEFAULTS, LIMITS, UNASSIGNED };
