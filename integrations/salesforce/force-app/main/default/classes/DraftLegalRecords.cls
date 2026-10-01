/**
 * Reads the deal records a launch or a change sends to draftLegal: the
 * Opportunity, its Account and (in orgs with Quotes) the Quote, with just the
 * fields draftLegal's field map names. Queries run in user mode, so a rep only
 * sends what field-level security lets them see.
 */
public with sharing class DraftLegalRecords {
    private static final Pattern FIELD_PATH = Pattern.compile('^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*){0,2}$');
    private static final Set<String> OBJECTS = new Set<String>{ 'Opportunity', 'Account', 'Quote' };

    /**
     * The records for `recordId`, keyed by object name, each with Id, Name and
     * the mapped fields that exist. `fields` is the launch form's field list.
     */
    public static Map<String, Map<String, Object>> load(Id recordId, List<Object> fields) {
        Map<String, Set<String>> wanted = new Map<String, Set<String>>();
        for (String obj : OBJECTS) {
            wanted.put(obj, new Set<String>{ 'Id', 'Name' });
        }
        if (fields != null) {
            for (Object f : fields) {
                Map<String, Object> field = (Map<String, Object>) f;
                String obj = (String) field.get('externalObject');
                String path = (String) field.get('externalField');
                if (wanted.containsKey(obj) && path != null && FIELD_PATH.matcher(path).matches()) {
                    wanted.get(obj).add(path);
                }
            }
        }

        Map<String, Id> ids = relatedIds(recordId);
        Map<String, Map<String, Object>> records = new Map<String, Map<String, Object>>();
        for (String obj : ids.keySet()) {
            Map<String, Object> rec = queryOne(obj, ids.get(obj), wanted.get(obj));
            if (rec != null) {
                records.put(obj, rec);
            }
        }
        return records;
    }

    /** The Opportunity, Account and Quote a record belongs to. */
    @TestVisible
    private static Map<String, Id> relatedIds(Id recordId) {
        Map<String, Id> ids = new Map<String, Id>();
        String type = recordId.getSobjectType().getDescribe().getName();
        if (type == 'Opportunity') {
            ids.put('Opportunity', recordId);
            Opportunity o = [SELECT AccountId FROM Opportunity WHERE Id = :recordId WITH USER_MODE LIMIT 1];
            if (o.AccountId != null) {
                ids.put('Account', o.AccountId);
            }
        } else if (type == 'Quote') {
            // Dynamic, so the package installs in orgs without Quotes.
            SObject q = Database.query('SELECT OpportunityId, AccountId FROM Quote WHERE Id = :recordId LIMIT 1', AccessLevel.USER_MODE);
            ids.put('Quote', recordId);
            if (q.get('OpportunityId') != null) {
                ids.put('Opportunity', (Id) q.get('OpportunityId'));
            }
            if (q.get('AccountId') != null) {
                ids.put('Account', (Id) q.get('AccountId'));
            }
        } else if (type == 'Account') {
            ids.put('Account', recordId);
        }
        return ids;
    }

    /**
     * One record with the fields that exist (a field the map names but this org
     * lacks, or the user can't read, is left out rather than failing the launch).
     */
    @TestVisible
    private static Map<String, Object> queryOne(String obj, Id recordId, Set<String> fields) {
        Map<String, Schema.SObjectField> known = Schema.getGlobalDescribe().get(obj).getDescribe().fields.getMap();
        List<String> selectable = new List<String>();
        for (String f : fields) {
            // Relationship paths (Account.Name) are checked by the query itself.
            if (f.contains('.') || known.containsKey(f.toLowerCase())) {
                selectable.add(f);
            }
        }
        String soql = 'SELECT ' + String.join(selectable, ', ') + ' FROM ' + obj + ' WHERE Id = :recordId LIMIT 1';
        List<SObject> rows;
        try {
            rows = Database.query(soql, AccessLevel.USER_MODE);
        } catch (QueryException e) {
            // A relationship path the org lacks: fall back to the plain fields.
            List<String> plain = new List<String>();
            for (String f : selectable) {
                if (!f.contains('.')) {
                    plain.add(f);
                }
            }
            rows = Database.query('SELECT ' + String.join(plain, ', ') + ' FROM ' + obj + ' WHERE Id = :recordId LIMIT 1', AccessLevel.USER_MODE);
        }
        if (rows.isEmpty()) {
            return null;
        }
        Map<String, Object> rec = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(rows[0]));
        stripAttributes(rec);
        return rec;
    }

    private static void stripAttributes(Map<String, Object> rec) {
        rec.remove('attributes');
        for (Object v : rec.values()) {
            if (v instanceof Map<String, Object>) {
                stripAttributes((Map<String, Object>) v);
            }
        }
    }

    /** A field by path ("Amount", "Account.Name") in a record map. */
    public static Object readPath(Map<String, Object> rec, String path) {
        Object at = rec;
        for (String part : path.split('\\.')) {
            if (!(at instanceof Map<String, Object>)) {
                return null;
            }
            at = ((Map<String, Object>) at).get(part);
        }
        return at;
    }

    /**
     * The rep's edits, keyed "Object.Field", onto the records. Only top-level
     * fields the form showed as editable; a locked field keeps the record's value.
     */
    public static void applyOverrides(Map<String, Map<String, Object>> records, List<Object> fields, String overridesJson) {
        if (String.isBlank(overridesJson) || fields == null) {
            return;
        }
        Map<String, Object> overrides = (Map<String, Object>) JSON.deserializeUntyped(overridesJson);
        for (Object f : fields) {
            Map<String, Object> field = (Map<String, Object>) f;
            String obj = (String) field.get('externalObject');
            String path = (String) field.get('externalField');
            String key = obj + '.' + path;
            if (field.get('locked') == true || path.contains('.') || !overrides.containsKey(key)) {
                continue;
            }
            if (!records.containsKey(obj)) {
                records.put(obj, new Map<String, Object>());
            }
            records.get(obj).put(path, overrides.get(key));
        }
    }
}
