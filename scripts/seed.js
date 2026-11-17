// Optional: `npm run seed` adds clearly labelled EXAMPLE tasks for demonstrations.
// The people on the sample tasks are mixed on purpose: nobody "owns" a module.
// It never runs automatically, and it refuses to run twice on the same database.

const { loadConfig } = require('../src/config');
const { openDatabase, transaction, getMeta, setMeta } = require('../src/database');
const { createTask, addComment } = require('../src/taskStore');
const { todayInDubai, addDays } = require('../src/dates');

const config = loadConfig();
const db = openDatabase(config.dbFile);
const today = todayInDubai();
const inDays = days => addDays(today, days);

if (getMeta(db, 'sample_seeded')) {
  console.log('Sample tasks were already added to this database. Nothing was changed.');
  db.close();
  process.exit(0);
}

const note = 'Sample task for demonstration only. Safe to move to Trash.';
const samples = [
  { title: 'Map customer master fields from the old ERP', module: 'CRM', assignee: 'Thameem', priority: 'High', status: 'In Progress', dueDate: inDays(3),
    comments: [['Thameem', 'Exported the old customer table; 14 fields have no clear equivalent yet.'], ['Parimitha', 'Finance needs the VAT registration number kept as a separate field.']] },
  { title: 'Design supplier onboarding form', module: 'Purchase', assignee: 'Parimitha', priority: 'Medium', status: 'To Do', dueDate: inDays(10) },
  { title: 'Define chart of accounts structure', module: 'Financials', assignee: 'Parimitha', priority: 'High', status: 'In Progress', dueDate: inDays(-2),
    comments: [['Parimitha', 'Waiting for the final cost-centre list from accounts.']] },
  { title: 'Build invoice numbering rules', module: 'Financials', assignee: 'Mausooq', priority: 'Medium', status: 'To Do', dueDate: inDays(7) },
  { title: 'Instant quote screen: first draft', module: 'Pricing', assignee: 'Rashneema', priority: 'High', status: 'In Progress', dueDate: today },
  { title: 'Lead pipeline stages and statuses', module: 'CRM', assignee: 'Thameem', priority: 'Low', status: 'Completed', dueDate: inDays(-5) },
  { title: 'Shipment tracking status model', module: 'Tracking', assignee: 'Mausooq', priority: 'High', status: 'Blocked', dueDate: inDays(-1),
    comments: [['Mausooq', 'Blocked: carrier API sandbox credentials have not arrived.']] },
  { title: 'Evaluate OCR accuracy on bills of lading', module: 'Documents & OCR', assignee: 'Rashneema', priority: 'Medium', status: 'To Do', dueDate: inDays(14) },
  { title: 'Document upload size and type rules', module: 'Documents & OCR', assignee: 'Thameem', priority: 'Low', status: 'Completed', dueDate: null },
  { title: 'List third-party APIs the old ERP calls', module: 'Integrations & APIs', assignee: 'Mausooq', priority: 'Medium', status: 'Completed', dueDate: inDays(-8) },
  { title: 'Monthly sales report layout', module: 'MIS', assignee: 'Parimitha', priority: 'Low', status: 'To Do', dueDate: inDays(21) },
  { title: 'Practise IIS reverse proxy to the Node.js app', module: 'Deployment & Infrastructure', assignee: 'Rashneema', priority: 'Medium', status: 'To Do', dueDate: inDays(5),
    comments: [['Rashneema', 'Team lead will walk through PM2, DNS and IIS this week.']] },
  { title: 'List job types handled in Forwarding', module: 'Forwarding', assignee: 'Rashneema', priority: 'Medium', status: 'To Do', dueDate: inDays(9) },
  { title: 'Customs declaration fields checklist', module: 'Customs', assignee: 'Thameem', priority: 'Medium', status: 'To Do', dueDate: inDays(12) },
  { title: 'Compare Warehouse (Advance) and Warehouse (Basic) screens', module: 'Warehouse (Advance)', assignee: 'Mausooq', priority: 'Low', status: 'To Do', dueDate: null },
  { title: 'KPI list for management dashboards', module: 'Business Intelligence', assignee: 'Parimitha', priority: 'Low', status: 'To Do', dueDate: inDays(18) },
  { title: 'Agree naming convention for database tables', module: 'General / Cross-module', assignee: null, priority: 'Low', status: 'To Do', dueDate: null }
];

transaction(db, () => {
  for (const sample of samples) {
    const task = createTask(db, {
      title: `[Sample] ${sample.title}`, description: note, module: sample.module, assignee: sample.assignee,
      priority: sample.priority, status: sample.status, dueDate: sample.dueDate
    });
    for (const [author, body] of sample.comments || []) addComment(db, task.id, { author, body });
  }
  setMeta(db, 'sample_seeded', new Date().toISOString());
});

console.log(`Added ${samples.length} sample tasks (titles start with "[Sample]") to ${config.dbFile}.`);
console.log('Refresh the browser to see them.');
db.close();
