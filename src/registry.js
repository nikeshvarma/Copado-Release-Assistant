'use strict';

/**
 * Describes Salesforce metadata structure, not generic XML.
 *
 * For every repeatable element we record:
 *   key      - child tags whose values together identify the entry
 *              (all present candidates are joined, so it works for both
 *               composite keys and "one of these" keys)
 *   sortable - safe to reorder alphabetically (false where document order
 *              is semantic, e.g. layout sections, picklist values)
 *   noDedupe - positional container, identical siblings are legal
 *
 * strict: true means the collection list below is considered complete for that
 * type, so any other repeated top-level element is reported as a duplicate
 * singleton. Set it to false for types you have not fully described.
 *
 * order is the list of top-level tags that go first, in that exact order.
 * Everything not listed follows alphabetically, which is what the Metadata API
 * writes for level-1 elements. The convention here is to list the elements the
 * type allows only once - the identity of the file - and let the collections
 * sort themselves. Nothing below level 1 is ever reordered.
 *
 * Add your own types here - the file is plain data.
 */

const DEFAULT = { key: ['fullName', 'name'], sortable: false };

const TYPES = {
  Profile: {
    strict: true,
    // Salesforce writes profile elements alphabetically, custom and userLicense included.
    order: ['fullName'],
    collections: {
      applicationVisibilities: { key: ['application'], sortable: true },
      categoryGroupVisibilities: { key: ['dataCategoryGroup'], sortable: true },
      classAccesses: { key: ['apexClass'], sortable: true },
      customMetadataTypeAccesses: { key: ['name'], sortable: true },
      customPermissions: { key: ['name'], sortable: true },
      customSettingAccesses: { key: ['name'], sortable: true },
      externalCredentialPrincipalAccesses: { key: ['externalCredentialPrincipal'], sortable: true },
      externalDataSourceAccesses: { key: ['externalDataSource'], sortable: true },
      fieldPermissions: { key: ['field'], sortable: true },
      flowAccesses: { key: ['flow'], sortable: true },
      layoutAssignments: { key: ['layout', 'recordType'], sortable: true },
      loginIpRanges: { key: ['startAddress', 'endAddress'], sortable: true },
      objectPermissions: { key: ['object'], sortable: true },
      pageAccesses: { key: ['apexPage'], sortable: true },
      profileActionOverrides: { key: ['actionName', 'recordType', 'type', 'formFactor'], sortable: true },
      recordTypeVisibilities: { key: ['recordType'], sortable: true },
      tabVisibilities: { key: ['tab'], sortable: true },
      userPermissions: { key: ['name'], sortable: true }
    }
  },

  PermissionSet: {
    strict: true,
    // The only elements a PermissionSet allows once. Everything else is a
    // collection and follows alphabetically.
    order: ['fullName'],
    collections: {
      applicationVisibilities: { key: ['application'], sortable: true },
      classAccesses: { key: ['apexClass'], sortable: true },
      customMetadataTypeAccesses: { key: ['name'], sortable: true },
      customPermissions: { key: ['name'], sortable: true },
      customSettingAccesses: { key: ['name'], sortable: true },
      externalCredentialPrincipalAccesses: { key: ['externalCredentialPrincipal'], sortable: true },
      externalDataSourceAccesses: { key: ['externalDataSource'], sortable: true },
      fieldPermissions: { key: ['field'], sortable: true },
      flowAccesses: { key: ['flow'], sortable: true },
      objectPermissions: { key: ['object'], sortable: true },
      pageAccesses: { key: ['apexPage'], sortable: true },
      recordTypeVisibilities: { key: ['recordType'], sortable: true },
      tabSettings: { key: ['tab'], sortable: true },
      userPermissions: { key: ['name'], sortable: true }
    }
  },

  PermissionSetGroup: {
    strict: true,
    order: ['fullName'],
    collections: {
      permissionSets: { sortable: true },
      mutingPermissionSets: { sortable: true }
    }
  },

  MutingPermissionSet: {
    strict: false,
    order: ['fullName'],
    collections: {
      applicationVisibilities: { key: ['application'], sortable: true },
      classAccesses: { key: ['apexClass'], sortable: true },
      customPermissions: { key: ['name'], sortable: true },
      fieldPermissions: { key: ['field'], sortable: true },
      objectPermissions: { key: ['object'], sortable: true },
      pageAccesses: { key: ['apexPage'], sortable: true },
      userPermissions: { key: ['name'], sortable: true }
    }
  },

  CustomObject: {
    strict: true,
    order: ['fullName'],
    collections: {
      actionOverrides: { key: ['actionName', 'formFactor', 'type'], sortable: true },
      businessProcesses: { key: ['fullName'], sortable: true },
      'businessProcesses/values': { key: ['fullName'], sortable: false },
      compactLayouts: { key: ['fullName'], sortable: true },
      'compactLayouts/fields': { sortable: false },
      fieldSets: { key: ['fullName'], sortable: true },
      'fieldSets/availableFields': { key: ['field'], sortable: false },
      'fieldSets/displayedFields': { key: ['field'], sortable: false },
      fields: { key: ['fullName'], sortable: true },
      'fields/valueSet/valueSetDefinition/value': { key: ['fullName'], sortable: false },
      'fields/lookupFilter/filterItems': { key: ['field', 'operation', 'value', 'valueField'], sortable: false },
      indexes: { key: ['fullName'], sortable: true },
      'indexes/fields': { key: ['name'], sortable: false },
      listViews: { key: ['fullName'], sortable: true },
      'listViews/columns': { sortable: false },
      'listViews/filters': { key: ['field', 'operation', 'value'], sortable: false },
      'listViews/sharedTo/group': { sortable: true },
      'listViews/sharedTo/role': { sortable: true },
      namedFilters: { key: ['fullName'], sortable: true },
      profileSearchLayouts: { key: ['profileName'], sortable: true },
      recordTypes: { key: ['fullName'], sortable: true },
      'recordTypes/picklistValues': { key: ['picklist'], sortable: true },
      'recordTypes/picklistValues/values': { key: ['fullName'], sortable: false },
      'searchLayouts/customTabListAdditionalFields': { sortable: false },
      'searchLayouts/excludedStandardButtons': { sortable: false },
      'searchLayouts/listViewButtons': { sortable: false },
      'searchLayouts/lookupDialogsAdditionalFields': { sortable: false },
      'searchLayouts/lookupFilterFields': { sortable: false },
      'searchLayouts/lookupPhoneDialogsAdditionalFields': { sortable: false },
      'searchLayouts/massQuickActions': { sortable: false },
      'searchLayouts/searchFilterFields': { sortable: false },
      'searchLayouts/searchResultsAdditionalFields': { sortable: false },
      'searchLayouts/searchResultsCustomButtons': { sortable: false },
      sharingReasons: { key: ['fullName'], sortable: true },
      sharingRecalculations: { key: ['className'], sortable: true },
      validationRules: { key: ['fullName'], sortable: true },
      webLinks: { key: ['fullName'], sortable: true }
    }
  },

  CustomField: {
    strict: true,
    order: ['fullName'],
    collections: {
      'valueSet/valueSetDefinition/value': { key: ['fullName'], sortable: false },
      'valueSet/valueSettings': { key: ['valueName'], sortable: false },
      'valueSet/valueSettings/controllingFieldValue': { sortable: false },
      'lookupFilter/filterItems': { key: ['field', 'operation', 'value', 'valueField'], sortable: false }
    }
  },

  GlobalValueSet: {
    strict: true,
    collections: { customValue: { key: ['fullName'], sortable: false } }
  },

  StandardValueSet: {
    strict: true,
    collections: { standardValue: { key: ['fullName'], sortable: false } }
  },

  RecordType: {
    strict: true,
    collections: {
      picklistValues: { key: ['picklist'], sortable: true },
      'picklistValues/values': { key: ['fullName'], sortable: false }
    }
  },

  Layout: {
    strict: true,
    order: ['fullName'],
    collections: {
      customButtons: { sortable: false },
      customConsoleComponents: { noDedupe: true },
      excludeButtons: { sortable: false },
      layoutSections: { key: ['label'], sortable: false },
      'layoutSections/layoutColumns': { noDedupe: true },
      'layoutSections/layoutColumns/layoutItems': {
        key: ['field', 'customLink', 'canvas', 'page', 'component', 'reportChartComponent', 'analyticsCloudComponent', 'scontrol'],
        sortable: false
      },
      multilineLayoutFields: { sortable: false },
      'platformActionList/platformActionListItems': { key: ['actionName'], sortable: false },
      'quickActionList/quickActionListItems': { key: ['quickActionName'], sortable: false },
      relatedLists: { key: ['relatedList'], sortable: false },
      'relatedLists/customButtons': { sortable: false },
      'relatedLists/excludeButtons': { sortable: false },
      'relatedLists/fields': { sortable: false },
      relatedObjects: { sortable: false },
      summaryLayouts: { key: ['summaryLayoutStyle'], sortable: false },
      'summaryLayouts/summaryLayoutItems': { key: ['field', 'customLink'], sortable: false }
    }
  },

  FlexiPage: {
    strict: false,
    collections: {
      flexiPageRegions: { key: ['name'], sortable: false },
      // an item is the component or field it holds: matched by its identifier, so a changed component is merged, not added twice
      'flexiPageRegions/itemInstances': { key: ['componentInstance/identifier', 'fieldInstance/identifier'], sortable: false },
      componentInstances: { noDedupe: true },
      componentInstanceProperties: { key: ['name'], sortable: false },
      // an action or a field in a list is its value: matched by it, so a shortened visibility rule is an edit, not a move
      valueListItems: { key: ['value'], sortable: false },
      quickActionInstances: { noDedupe: true },
      platformActionListItems: { key: ['actionName'], sortable: false }
    }
  },

  CustomApplication: {
    strict: true,
    order: ['fullName'],
    collections: {
      actionOverrides: { key: ['actionName', 'formFactor', 'type'], sortable: true },
      profileActionOverrides: { key: ['actionName', 'profile', 'recordType', 'type', 'formFactor'], sortable: true },
      tabs: { sortable: true },
      workspaceConfig: { noDedupe: true },
      'workspaceConfig/mappings': { key: ['tab'], sortable: true }
    }
  },

  CustomLabels: {
    strict: true,
    collections: { labels: { key: ['fullName'], sortable: true } }
  },

  Translations: {
    strict: false,
    collections: {
      customApplications: { key: ['name'], sortable: true },
      customLabels: { key: ['name'], sortable: true },
      customTabs: { key: ['name'], sortable: true },
      flowDefinitions: { key: ['fullName'], sortable: true },
      quickActions: { key: ['name'], sortable: true },
      reportTypes: { key: ['name'], sortable: true }
    }
  },

  CustomObjectTranslation: {
    strict: true,
    collections: {
      fields: { key: ['name'], sortable: true },
      'fields/picklistValues': { key: ['masterLabel'], sortable: true },
      fieldSets: { key: ['name'], sortable: true },
      layouts: { key: ['layout'], sortable: true },
      'layouts/sections': { key: ['label'], sortable: true },
      quickActions: { key: ['name'], sortable: true },
      recordTypes: { key: ['name'], sortable: true },
      sharingReasons: { key: ['name'], sortable: true },
      standardFields: { key: ['name'], sortable: true },
      validationRules: { key: ['name'], sortable: true },
      webLinks: { key: ['name'], sortable: true },
      workflowTasks: { key: ['name'], sortable: true }
    }
  },

  Workflow: {
    strict: true,
    order: ['fullName'],
    collections: {
      alerts: { key: ['fullName'], sortable: true },
      'alerts/recipients': { key: ['type', 'recipient', 'field'], sortable: true },
      'alerts/ccEmails': { sortable: true },
      fieldUpdates: { key: ['fullName'], sortable: true },
      flowActions: { key: ['fullName'], sortable: true },
      knowledgePublishes: { key: ['fullName'], sortable: true },
      outboundMessages: { key: ['fullName'], sortable: true },
      'outboundMessages/fields': { sortable: true },
      rules: { key: ['fullName'], sortable: true },
      'rules/actions': { key: ['name', 'type'], sortable: false },
      'rules/criteriaItems': { key: ['field', 'operation', 'value'], sortable: false },
      'rules/workflowTimeTriggers': { noDedupe: true },
      'rules/workflowTimeTriggers/actions': { key: ['name', 'type'], sortable: false },
      tasks: { key: ['fullName'], sortable: true }
    }
  },

  SharingRules: {
    strict: true,
    collections: {
      sharingCriteriaRules: { key: ['fullName'], sortable: true },
      'sharingCriteriaRules/criteriaItems': { key: ['field', 'operation', 'value'], sortable: false },
      sharingGuestRules: { key: ['fullName'], sortable: true },
      sharingOwnerRules: { key: ['fullName'], sortable: true },
      sharingTerritoryRules: { key: ['fullName'], sortable: true },
      'sharedTo/group': { sortable: true },
      'sharedTo/role': { sortable: true },
      'sharedTo/roleAndSubordinates': { sortable: true }
    }
  },

  MatchingRules: {
    strict: true,
    collections: {
      matchingRules: { key: ['fullName'], sortable: true },
      'matchingRules/matchingRuleItems': { key: ['fieldName'], sortable: false }
    }
  },

  AssignmentRules: {
    strict: true,
    collections: {
      assignmentRule: { key: ['fullName'], sortable: true },
      'assignmentRule/ruleEntry': { noDedupe: true },
      'assignmentRule/ruleEntry/criteriaItems': { key: ['field', 'operation', 'value'], sortable: false }
    }
  },

  AutoResponseRules: {
    strict: true,
    collections: {
      autoResponseRule: { key: ['fullName'], sortable: true },
      'autoResponseRule/ruleEntry': { noDedupe: true }
    }
  },

  EscalationRules: {
    strict: true,
    collections: {
      escalationRule: { key: ['fullName'], sortable: true },
      'escalationRule/ruleEntry': { noDedupe: true }
    }
  },

  Flow: {
    strict: false,
    collections: {
      'processMetadataValues': { key: ['name'], sortable: false },
      'choices': { key: ['name'], sortable: true },
      'constants': { key: ['name'], sortable: true },
      'formulas': { key: ['name'], sortable: true },
      'variables': { key: ['name'], sortable: true },
      'textTemplates': { key: ['name'], sortable: true },
      'connector': { noDedupe: true }
    }
  },

  QuickAction: {
    strict: true,
    collections: {
      'quickActionLayout/quickActionLayoutColumns': { noDedupe: true },
      'quickActionLayout/quickActionLayoutColumns/quickActionLayoutItems': { key: ['field'], sortable: false },
      fieldOverrides: { key: ['field'], sortable: true }
    }
  },

  Package: {
    strict: true,
    order: ['fullName', 'apiAccessLevel', 'description', 'namespacePrefix'],
    collections: {
      types: { key: ['name'], sortable: true },
      'types/members': { sortable: true }
    }
  },

  ApexClass: { strict: true, collections: { packageVersions: { key: ['namespace'], sortable: true } } },
  ApexTrigger: { strict: true, collections: { packageVersions: { key: ['namespace'], sortable: true } } },
  ApexPage: { strict: true, collections: { packageVersions: { key: ['namespace'], sortable: true } } },
  LightningComponentBundle: {
    strict: false,
    collections: {
      targets: { sortable: false },
      'targets/target': { sortable: false },
      'targetConfigs/targetConfig': { key: ['targets'], sortable: false },
      property: { key: ['name'], sortable: false },
      objects: { sortable: true },
      'objects/object': { sortable: true }
    }
  },
  AuraDefinitionBundle: { strict: false, collections: {} },
  CustomTab: { strict: true, collections: { actionOverrides: { key: ['actionName', 'formFactor', 'type'], sortable: true } } },
  CustomMetadata: { strict: true, collections: { values: { key: ['field'], sortable: true } } },
  CustomSite: { strict: false, collections: {} },
  Network: { strict: false, collections: { networkMemberGroups: { noDedupe: true }, 'networkMemberGroups/profile': { sortable: true }, 'networkMemberGroups/permissionSet': { sortable: true } } },
  ConnectedApp: { strict: false, collections: { oauthConfig: { noDedupe: true }, 'oauthConfig/scopes': { sortable: true } } },
  Report: { strict: false, collections: { columns: { key: ['field'], sortable: false }, groupingsDown: { key: ['field'], sortable: false }, groupingsAcross: { key: ['field'], sortable: false }, 'filter/criteriaItems': { key: ['column', 'operator', 'value'], sortable: false }, aggregates: { key: ['developerName'], sortable: false } } },
  Dashboard: { strict: false, collections: { dashboardFilters: { key: ['name'], sortable: false }, components: { noDedupe: true } } },
  ReportType: { strict: false, collections: { sections: { key: ['masterLabel'], sortable: false }, 'sections/columns': { key: ['field'], sortable: false }, join: { noDedupe: true } } }
};

/**
 * Resolve the collection spec for a repeated element.
 * path is the list of ancestor tag names below the root element.
 */
const specCache = new Map();

function specFor(typeName, path, tag) {
  const joined = path._k !== undefined ? path._k : (path._k = path.join('/'));
  const cacheKey = typeName + '\u0000' + joined + '\u0000' + tag;
  let spec = specCache.get(cacheKey);
  if (!spec) {
    spec = Object.freeze(lookupSpec(typeName, path, tag));
    specCache.set(cacheKey, spec);
  }
  return spec;
}

function lookupSpec(typeName, path, tag) {
  const def = TYPES[typeName];
  if (def) {
    const full = path.concat(tag).join('/');
    const cols = def.collections || {};
    if (cols[full]) return Object.assign({ known: true }, DEFAULT, cols[full]);
    // suffix match, e.g. "sharedTo/group" anywhere in the tree
    for (const p of Object.keys(cols)) {
      if (p.indexOf('/') !== -1 && (full === p || full.endsWith('/' + p))) {
        return Object.assign({ known: true }, DEFAULT, cols[p]);
      }
    }
    if (path.length === 0 && cols[tag]) return Object.assign({ known: true }, DEFAULT, cols[tag]);
    if (cols[tag]) return Object.assign({ known: true }, DEFAULT, cols[tag]);
  }
  return Object.assign({ known: false }, DEFAULT);
}

function isStrict(typeName) {
  const def = TYPES[typeName];
  return !!(def && def.strict);
}

function orderFor(typeName) {
  const def = TYPES[typeName];
  if (def && def.order) return def.order;
  return ['fullName'];        // then alphabetical, like the Metadata API
}

module.exports = { specFor, isStrict, orderFor };
