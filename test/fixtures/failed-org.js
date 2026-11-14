'use strict';

/**
 * A Copado org after a failed validation, for the tests of 3.0.3: promotion
 * P0042 (qa -> uat) has its conflicts resolved in Copado - one permission set
 * resolution is not well-formed XML (its root is never closed). Copado's
 * history on it:
 *
 *   JE-0100  an earlier merge job, linked to the promotion: failed on a merge conflict
 *   JE-0200  the merge job after the resolutions: successful
 *   DEP-0042 the validation - a deployment whose job execution JE-0300 hangs off
 *            the deployment, not the promotion; its result holds the real error,
 *            in Copado's own form: "Metadata Validation - Type:Name:problem\nType:Name:problem"
 *
 * The promotion has a "Re-create Promotion Branch" checkbox (opts.recreateField
 * renames it, or null leaves it out). Names are made up.
 */
const { createOrg } = require('./fake-org');

const PS = 'force-app/main/default/permissionsets/Ops_Manager.permissionset-meta.xml';
const CLS = 'force-app/main/default/classes/OpsService.cls';
const BROKEN = '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>Ops Manager</label>\n    <fieldPermissions>\n        <editable>true</editable>\n        <field>Account.Region__c</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
const FIXED = BROKEN + '</PermissionSet>\n';
const ERROR = 'Metadata Validation - PermissionSet:Ops_Manager:Error parsing file: The element type "PermissionSet" must be terminated by the matching end-tag "</PermissionSet>".\\nPermissionSet:Ops_Rep:Error parsing file: The element type "PermissionSet" must be terminated by the matching end-tag "</PermissionSet>".';

function failedOrg(opts) {
  const o = Object.assign({ recreateField: 'copado__Recreate_Promotion_Branch__c' }, opts || {});
  const t = (d, h) => '2026-11-' + d + 'T' + h + ':00:00.000+0000';
  const promoFields = ['Name', 'copado__Status__c', 'copado__Source_Environment__c', 'copado__Destination_Environment__c', 'CreatedDate', 'LastModifiedDate'].concat(o.recreateField ? [o.recreateField] : []);
  const schema = {
    copado__Environment__c: { fields: ['Name'] },
    copado__Promotion__c: { fields: promoFields, refs: { copado__Source_Environment__c: 'copado__Environment__c', copado__Destination_Environment__c: 'copado__Environment__c' },
      types: o.recreateField ? { [o.recreateField]: 'boolean' } : {}, labels: o.recreateField ? { [o.recreateField]: o.recreateLabel || 'Re-create Promotion Branch' } : {},
      picklists: { copado__Status__c: ['Draft', 'Merge Conflict', 'Conflicts Resolved', 'Completed'] } },
    copado__Promoted_User_Story__c: { fields: ['Name', 'copado__User_Story__c', 'copado__Promotion__c'], refs: { copado__Promotion__c: 'copado__Promotion__c' } },
    copado__Deployment__c: { fields: ['Name', 'copado__Promotion__c', 'copado__Status__c', 'CreatedDate', 'LastModifiedDate'], refs: { copado__Promotion__c: 'copado__Promotion__c' } },
    copado__JobExecution__c: { fields: ['Name', 'copado__Promotion__c', 'copado__Deployment__c', 'copado__Status__c', 'copado__ErrorMessage__c', 'CreatedDate', 'LastModifiedDate'],
      refs: { copado__Promotion__c: 'copado__Promotion__c', copado__Deployment__c: 'copado__Deployment__c' } },
    copado__JobStep__c: { fields: ['Name', 'copado__JobExecution__c', 'copado__Status__c', 'copado__Order__c', 'copado__Type__c', 'CreatedDate', 'LastModifiedDate'], refs: { copado__JobExecution__c: 'copado__JobExecution__c' } },
    copado__Result__c: { fields: ['Name', 'copado__JobStep__c', 'copado__Status__c', 'copado__Progress_Status__c', 'copado__Error_Message__c', 'CreatedDate', 'LastModifiedDate'], refs: { copado__JobStep__c: 'copado__JobStep__c' } },
    Attachment: { fields: ['Name', 'ParentId', 'BodyLength', 'CreatedDate', 'LastModifiedDate'] },
    ContentDocument: { fields: ['Title', 'LatestPublishedVersionId', 'ContentSize', 'CreatedDate', 'LastModifiedDate'] },
    ContentDocumentLink: { fields: ['ContentDocumentId', 'LinkedEntityId'], refs: { ContentDocumentId: 'ContentDocument' } }
  };
  const data = {
    copado__Environment__c: [{ Id: 'E0QA', Name: 'qa' }, { Id: 'E0UAT', Name: 'uat' }],
    copado__Promotion__c: [Object.assign({ Id: 'P42', Name: 'P0042', copado__Status__c: 'Conflicts Resolved', copado__Source_Environment__c: 'E0QA', copado__Destination_Environment__c: 'E0UAT',
      CreatedDate: t('10', '08'), LastModifiedDate: t('10', '20') }, o.recreateField ? { [o.recreateField]: false } : {})],
    copado__Promoted_User_Story__c: [],
    copado__Deployment__c: [{ Id: 'DEP42', Name: 'DEP-0042', copado__Promotion__c: 'P42', copado__Status__c: 'Completed with Errors', CreatedDate: t('10', '21'), LastModifiedDate: t('10', '21') }],
    copado__JobExecution__c: [
      { Id: 'JE100', Name: 'JE-0100', copado__Promotion__c: 'P42', copado__Status__c: 'Error', CreatedDate: t('10', '19'), LastModifiedDate: t('10', '19'),
        copado__ErrorMessage__c: 'Copado Merge : Conflict found while merging feature/US-0000042 to promotion/P0042.' },
      { Id: 'JE200', Name: 'JE-0200', copado__Promotion__c: 'P42', copado__Status__c: 'Successful', CreatedDate: t('10', '20'), LastModifiedDate: t('10', '20') },
      // the validation's job: under the deployment - and, in some Copado versions, also linked to the promotion
      { Id: 'JE300', Name: 'JE-0300', copado__Promotion__c: 'P42', copado__Deployment__c: 'DEP42', copado__Status__c: 'Error', CreatedDate: t('10', '21'), LastModifiedDate: t('10', '21') }],
    copado__JobStep__c: [{ Id: 'JS100', Name: 'Promote', copado__JobExecution__c: 'JE100', copado__Status__c: 'Failed', copado__Order__c: 1, copado__Type__c: 'Function', CreatedDate: t('10', '19') },
      { Id: 'JS200', Name: 'Promote', copado__JobExecution__c: 'JE200', copado__Status__c: 'Success', copado__Order__c: 1, copado__Type__c: 'Function', CreatedDate: t('10', '20') },
      { Id: 'JS300', Name: 'Deploy', copado__JobExecution__c: 'JE300', copado__Status__c: 'Failed', copado__Order__c: 1, copado__Type__c: 'Function', CreatedDate: t('10', '21') }],
    copado__Result__c: [{ Id: 'R100', Name: 'R-0100', copado__JobStep__c: 'JS100', copado__Status__c: 'Failed', CreatedDate: t('10', '19'),
        copado__Error_Message__c: 'ApexClass OldThing: an error from an earlier run, long fixed' },
      { Id: 'R300', Name: 'R-0300', copado__JobStep__c: 'JS300', copado__Status__c: 'Failed', copado__Error_Message__c: ERROR.slice(0, 120), CreatedDate: t('10', '21') }],
    Attachment: [{ Id: 'AT1', Name: 'RESOLVED US-0000042 ' + PS, ParentId: 'P42', CreatedDate: t('10', '10'), LastModifiedDate: t('10', '10') },
      { Id: 'AT2', Name: 'RESOLVED US-0000042 ' + CLS, ParentId: 'P42', CreatedDate: t('10', '10'), LastModifiedDate: t('10', '10') }],
    // the full message is in a file on the result, as Copado's "Error Details"
    ContentDocument: [{ Id: 'CD1', Title: 'Error Details', LatestPublishedVersionId: 'CV1', ContentSize: 400, CreatedDate: t('10', '21') }],
    ContentDocumentLink: [{ Id: 'CL1', ContentDocumentId: 'CD1', LinkedEntityId: 'R300' }]
  };
  const files = { AT1: BROKEN, AT2: 'public class OpsService {}\n', CV1: ERROR };
  return Object.assign(createOrg(schema, data, files), { data, files, PS, CLS, BROKEN, FIXED });
}

module.exports = { failedOrg };
