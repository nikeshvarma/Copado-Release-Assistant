'use strict';

/**
 * A Copado org with a whole pipeline, for the lifecycle tests:
 *
 *   dev1 ─┐
 *         ├─> int ──> qa ──> uat ──> prod        hotfix ──> prod
 *   dev2 ─┘
 *
 * Stories US-0000101 and -102 are in qa, in release "Spring"; 102 rides with
 * 101 in P0003 (qa -> uat), which is in merge conflict. US-0000103 is in dev2
 * on its way to int. US-0000104 is a hotfix (based on main), now in prod, with
 * a back-promotion P0005 from prod to uat. Their components come from the
 * story's commit file (101), a commit attachment (102) and metadata records (103).
 */
const { createOrg } = require('./fake-org');

const PROMO_FIELDS = ['Name', 'copado__Status__c', 'copado__Source_Environment__c', 'copado__Destination_Environment__c', 'CreatedDate', 'LastModifiedDate', 'copado__Project__c', 'copado__Release__c'];

function lifeOrg(opts) {
  const o = opts || {};
  const schema = {
    copado__Environment__c: { fields: ['Name'] },
    copado__Git_Repository__c: { fields: ['Name', 'copado__URI__c', 'copado__Pull_Request_Base_URL__c'] },
    copado__Deployment_Flow__c: { fields: ['Name', 'copado__Active__c', 'copado__Git_Repository__c', 'copado__Main_Branch__c'], refs: { copado__Git_Repository__c: 'copado__Git_Repository__c' } },
    copado__Deployment_Flow_Step__c: { fields: ['copado__Deployment_Flow__c', 'copado__Branch__c', 'copado__Destination_Branch__c', 'copado__Source_Environment__c', 'copado__Destination_Environment__c'],
      refs: { copado__Deployment_Flow__c: 'copado__Deployment_Flow__c', copado__Source_Environment__c: 'copado__Environment__c', copado__Destination_Environment__c: 'copado__Environment__c' } },
    copado__Project__c: { fields: ['Name', 'copado__Deployment_Flow__c'], refs: { copado__Deployment_Flow__c: 'copado__Deployment_Flow__c' } },
    copado__Release__c: { fields: ['Name', 'copado__Status__c', 'copado__Base_Branch__c', 'copado__Project__c', 'LastModifiedDate'], refs: { copado__Project__c: 'copado__Project__c' } },
    copado__Promotion__c: { fields: PROMO_FIELDS.concat(o.noBackField ? [] : ['copado__Back_Promotion__c']), types: { copado__Back_Promotion__c: 'boolean' },
      refs: { copado__Source_Environment__c: 'copado__Environment__c', copado__Destination_Environment__c: 'copado__Environment__c', copado__Project__c: 'copado__Project__c', copado__Release__c: 'copado__Release__c' } },
    copado__User_Story__c: { fields: ['Name', 'copado__User_Story_Title__c', 'copado__Status__c', 'copado__Environment__c', 'copado__Project__c', 'copado__Release__c', 'copado__Base_Branch__c', 'copado__Feature_Branch__c', 'LastModifiedDate'],
      refs: { copado__Environment__c: 'copado__Environment__c', copado__Project__c: 'copado__Project__c', copado__Release__c: 'copado__Release__c' } },
    copado__Promoted_User_Story__c: { fields: ['Name', 'copado__User_Story__c', 'copado__Promotion__c', 'CreatedDate'], refs: { copado__User_Story__c: 'copado__User_Story__c', copado__Promotion__c: 'copado__Promotion__c' } },
    copado__User_Story_Commit__c: { fields: ['Name', 'copado__User_Story__c', 'CreatedDate'], refs: { copado__User_Story__c: 'copado__User_Story__c' } },
    copado__User_Story_Metadata__c: { fields: ['Name', 'copado__User_Story__c', 'copado__Metadata_API_Name__c', 'copado__Type__c', 'copado__Action__c'], refs: { copado__User_Story__c: 'copado__User_Story__c' } },
    copado__Org__c: { fields: ['Name', 'copado__Username__c', 'copado__Environment__c', 'copado__Default_Credential__c'], refs: { copado__Environment__c: 'copado__Environment__c' } },
    ContentDocument: { fields: ['Title', 'LatestPublishedVersionId', 'LastModifiedDate', 'CreatedDate', 'FileExtension', 'ContentSize'] },
    ContentDocumentLink: { fields: ['ContentDocumentId', 'LinkedEntityId'], refs: { ContentDocumentId: 'ContentDocument' } },
    Attachment: { fields: ['Name', 'ParentId', 'BodyLength', 'CreatedDate', 'LastModifiedDate'] }
  };
  const env = (Id, Name) => ({ Id, Name });
  const step = (Id, from, branch, to, toBranch) => ({ Id, copado__Deployment_Flow__c: 'F1', copado__Source_Environment__c: from, copado__Branch__c: branch, copado__Destination_Environment__c: to, copado__Destination_Branch__c: toBranch || null });
  const promo = (Id, Name, from, to, status, day, back) => Object.assign({ Id, Name, copado__Source_Environment__c: from, copado__Destination_Environment__c: to, copado__Status__c: status,
    CreatedDate: '2026-11-' + day + 'T09:00:00.000+0000', LastModifiedDate: '2026-11-' + day + 'T10:00:00.000+0000', copado__Project__c: 'PJ1' }, o.noBackField ? {} : { copado__Back_Promotion__c: !!back });
  const story = (Id, Name, title, envId, release, base, branch) => ({ Id, Name, copado__User_Story_Title__c: title, copado__Status__c: 'In Progress', copado__Environment__c: envId, copado__Project__c: 'PJ1',
    copado__Release__c: release, copado__Base_Branch__c: base, copado__Feature_Branch__c: branch || null, LastModifiedDate: '2026-11-10T00:00:00.000+0000' });
  const link = (Id, sid, pid, day) => ({ Id, copado__User_Story__c: sid, copado__Promotion__c: pid, CreatedDate: '2026-11-' + day + 'T09:00:00.000+0000' });
  const data = {
    copado__Environment__c: [env('E0D1', 'dev1'), env('E0D2', 'dev2'), env('E0INT', 'int'), env('E0QA', 'qa'), env('E0UAT', 'uat'), env('E0PRD', 'prod'), env('E0HF', 'hotfix')],
    copado__Git_Repository__c: [{ Id: 'R1', Name: 'sales-repo', copado__URI__c: o.uri || 'git@github.com:acme/sales.git', copado__Pull_Request_Base_URL__c: 'https://github.com/acme/sales/pull' }],
    copado__Deployment_Flow__c: [{ Id: 'F1', Name: 'Sales pipeline', copado__Active__c: true, copado__Git_Repository__c: 'R1', copado__Main_Branch__c: 'main' },
      { Id: 'F0', Name: 'Old pipeline', copado__Active__c: false, copado__Git_Repository__c: null, copado__Main_Branch__c: 'master' }],
    copado__Deployment_Flow_Step__c: [step('ST1', 'E0D1', 'dev1', 'E0INT', 'int'), step('ST2', 'E0D2', 'dev2', 'E0INT'), step('ST3', 'E0INT', 'int', 'E0QA'), step('ST4', 'E0QA', 'qa', 'E0UAT'),
      step('ST5', 'E0UAT', 'uat', 'E0PRD', 'main'), step('ST6', 'E0HF', 'hotfix', 'E0PRD')],
    copado__Project__c: [{ Id: 'PJ1', Name: 'Sales', copado__Deployment_Flow__c: 'F1' }],
    copado__Release__c: [{ Id: 'RL1', Name: 'Spring', copado__Status__c: 'In progress', copado__Base_Branch__c: 'int', copado__Project__c: 'PJ1', LastModifiedDate: '2026-11-11T00:00:00.000+0000' },
      { Id: 'RL0', Name: 'Winter', copado__Status__c: 'Released', copado__Base_Branch__c: 'int', copado__Project__c: 'PJ1', LastModifiedDate: '2026-01-01T00:00:00.000+0000' }],
    copado__Promotion__c: [promo('P1', 'P0001', 'E0D1', 'E0INT', 'Completed', '01'), promo('P2', 'P0002', 'E0INT', 'E0QA', 'Completed', '03'),
      promo('P3', 'P0003', 'E0QA', 'E0UAT', 'Merge Conflict', '05'), promo('P4', 'P0004', 'E0D2', 'E0INT', 'In Progress', '06'),
      promo('P5', 'P0005', 'E0PRD', 'E0UAT', 'Scheduled', '08', true), promo('P6', 'P0006', 'E0HF', 'E0PRD', 'Completed', '07')],
    copado__User_Story__c: [story('S1', 'US-0000101', 'Billing access', 'E0QA', 'RL1', 'int', 'feature/US-0000101'), story('S2', 'US-0000102', 'Invoice layout', 'E0QA', 'RL1', 'int'),
      story('S3', 'US-0000103', 'Sales permissions', 'E0D2', 'RL1', 'int'), story('S4', 'US-0000104', 'Fix tax rounding', 'E0PRD', null, 'main')],
    copado__Promoted_User_Story__c: [link('L1', 'S1', 'P1', '01'), link('L2', 'S1', 'P2', '03'), link('L3', 'S1', 'P3', '05'), link('L4', 'S2', 'P3', '05'), link('L5', 'S3', 'P4', '06'),
      link('L6', 'S4', 'P6', '07'), link('L7', 'S4', 'P5', '08')],
    copado__User_Story_Commit__c: [{ Id: 'C2', copado__User_Story__c: 'S2', CreatedDate: '2026-11-02T00:00:00.000+0000' }],
    copado__User_Story_Metadata__c: [{ Id: 'M3', copado__User_Story__c: 'S3', copado__Metadata_API_Name__c: 'PermissionSet.Sales', copado__Type__c: 'PermissionSet', copado__Action__c: 'Add' }],
    copado__Org__c: [{ Id: 'O1', Name: 'qa me', copado__Username__c: 'ME@example.com.qa', copado__Environment__c: 'E0QA', copado__Default_Credential__c: false },
      { Id: 'O2', Name: 'uat release', copado__Username__c: 'release@example.com.uat', copado__Environment__c: 'E0UAT', copado__Default_Credential__c: true },
      { Id: 'O3', Name: 'int me', copado__Username__c: 'me@example.com.int', copado__Environment__c: 'E0INT', copado__Default_Credential__c: true }],
    ContentDocument: [{ Id: 'D1', Title: 'Copado Commit changes', LatestPublishedVersionId: 'V1', LastModifiedDate: '2026-11-02T00:00:00.000+0000' },
      { Id: 'D9', Title: 'notes', LatestPublishedVersionId: 'V9', LastModifiedDate: '2026-11-02T00:00:00.000+0000' },
      { Id: 'DP', Title: 'Copado Promotion changes', LatestPublishedVersionId: 'VP', LastModifiedDate: '2026-11-05T00:00:00.000+0000', CreatedDate: '2026-11-05T00:00:00.000+0000' }],
    ContentDocumentLink: [{ Id: 'CL1', ContentDocumentId: 'D1', LinkedEntityId: 'S1' }, { Id: 'CL9', ContentDocumentId: 'D9', LinkedEntityId: 'S2' }, { Id: 'CLP', ContentDocumentId: 'DP', LinkedEntityId: 'P3' }],
    Attachment: [{ Id: 'AT2', Name: 'Copado_Commit_changes.json', ParentId: 'C2', CreatedDate: '2026-11-02T00:00:00.000+0000' }]
  };
  const files = {
    V1: JSON.stringify([{ t: 'ApexClass', n: 'AccountService', a: 'Add' }, { t: 'PermissionSet', n: 'Sales', a: 'Add' }, { t: 'Layout', n: 'Account-Main', a: 'RetrieveOnly' }]),
    V9: 'just notes',
    AT2: JSON.stringify([{ t: 'ApexClass', n: 'AccountService', a: 'Add' }, { t: 'Profile', n: 'Admin', a: 'Add' }, { t: 'Layout', n: 'Account-Main', a: 'RetrieveOnly' }]),
    VP: JSON.stringify([{ t: 'ApexClass', n: 'AccountService', a: 'Add' }, { t: 'ApexClass', n: 'AccountServiceTest', a: 'Add' }, { t: 'PermissionSet', n: 'Sales', a: 'Add' }])
  };
  Object.assign(schema, o.moreSchema || {});
  for (const [k, rows] of Object.entries(o.more || {})) data[k] = (data[k] || []).concat(rows);
  Object.assign(files, o.moreFiles || {});
  return createOrg(schema, data, files);
}

module.exports = { lifeOrg };
