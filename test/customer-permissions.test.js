const test = require('node:test');
const assert = require('node:assert/strict');

const { _permissions } = require('../controller/customers');

const engineer = { id: 11, name: 'Assigned Engineer', role: 'sales_engineer' };
const otherEngineer = { id: 12, name: 'Other Engineer', role: 'sales_engineer' };
const assignedCustomer = { account_owner_user_id: 11, account_owner_name: engineer.name };

test('customer managers can modify and assign every customer', () => {
  for (const role of ['admin', 'sales_head', 'presales']) {
    assert.equal(_permissions.isCustomerManager({ id: 1, role }), true);
    assert.equal(_permissions.canAccessOwnedCustomer(assignedCustomer, { id: 1, role }), true);
  }
});

test('only the assigned Sales Engineer can modify an owned customer', () => {
  assert.equal(_permissions.canAccessOwnedCustomer(assignedCustomer, engineer), true);
  assert.equal(_permissions.canAccessOwnedCustomer(assignedCustomer, otherEngineer), false);
});

test('legacy unassigned customers fall back to linked lead ownership', () => {
  assert.equal(_permissions.canAccessOwnedCustomer({ owns_linked_lead: true }, engineer), true);
  assert.equal(_permissions.canAccessOwnedCustomer({ owns_linked_lead: false }, engineer), false);
});
