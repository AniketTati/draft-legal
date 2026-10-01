/**
 * Calls into draftLegal through the `draftLegal` Named Credential (its API key,
 * with the `salesforce` scope, sent as a bearer token). Every call carries this
 * org's id, which draftLegal checks against the org it connected: a key used
 * from any other Salesforce org is refused.
 *
 * The methods marked @AuraEnabled serve the Lightning components:
 *   launchForm     — the "New contract" form: the field map, filled from the record
 *   createRequest  — send the form to draftLegal (or generate a self-serve type)
 *   contractStatus — stage, whose turn, approvals and key terms of a contract
 *   embedUrl       — a short-lived link to the read-only document preview
 */
public with sharing class DraftLegalApi {
    @TestVisible
    private static final String BASE = 'callout:draftLegal/api/v1/integrations/salesforce';

    public class DraftLegalException extends Exception {}

    @TestVisible
    private static HttpResponse send(String method, String path, Object body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(BASE + path);
        req.setMethod(method);
        req.setTimeout(20000);
        req.setHeader('Accept', 'application/json');
        req.setHeader('X-Salesforce-Org-Id', UserInfo.getOrganizationId());
        if (body != null) {
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(body, true));
        }
        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() >= 300) {
            throw new DraftLegalException(errorDetail(res));
        }
        return res;
    }

    /** draftLegal's own explanation of a refusal (its `detail`), else the status. */
    @TestVisible
    private static String errorDetail(HttpResponse res) {
        try {
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            if (body.get('detail') != null) {
                return String.valueOf(body.get('detail'));
            }
        } catch (Exception ignored) {
            // Not JSON: fall through to the status.
        }
        return 'draftLegal answered ' + res.getStatusCode();
    }

    public static Map<String, Object> getJson(String path) {
        return (Map<String, Object>) JSON.deserializeUntyped(send('GET', path, null).getBody());
    }

    public static Map<String, Object> postJson(String path, Object body) {
        return (Map<String, Object>) JSON.deserializeUntyped(send('POST', path, body).getBody());
    }

    /**
     * The launch form for a contract type on a record (Opportunity, Quote or
     * Account): draftLegal's field map, each field with the record's current
     * value. Without a type, only the list of types.
     */
    @AuraEnabled
    public static Map<String, Object> launchForm(Id recordId, String contractType) {
        try {
            String query = String.isBlank(contractType) ? '' : '?contractType=' + EncodingUtil.urlEncode(contractType, 'UTF-8');
            Map<String, Object> form = getJson('/launch-form' + query);
            List<Object> fields = (List<Object>) form.get('fields');
            if (fields == null || fields.isEmpty() || String.isBlank(contractType)) {
                return form;
            }
            Map<String, Map<String, Object>> records = DraftLegalRecords.load(recordId, fields);
            for (Object f : fields) {
                Map<String, Object> field = (Map<String, Object>) f;
                Map<String, Object> rec = records.get((String) field.get('externalObject'));
                field.put('value', rec == null ? null : DraftLegalRecords.readPath(rec, (String) field.get('externalField')));
            }
            return form;
        } catch (DraftLegalException e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    /**
     * Send a request to draftLegal from a record. `overridesJson` holds the
     * values the rep changed on the form, keyed "Object.Field"; read-only
     * (locked) fields keep the record's value whatever is sent.
     */
    @AuraEnabled
    public static Map<String, Object> createRequest(Id recordId, String contractType, String overridesJson, Boolean generateNow) {
        try {
            List<DL_Request__c> rows = new List<DL_Request__c>();
            Map<String, Object> created = request(recordId, contractType, overridesJson, generateNow == true, rows);
            upsert rows DL_Request_Id__c;
            return created;
        } catch (DraftLegalException e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    /**
     * Callouts first, records after: Salesforce refuses a callout once the
     * transaction has written anything, so the request's DL_Request__c row is
     * added to `rows` for the caller to save after its last callout.
     */
    public static Map<String, Object> request(Id recordId, String contractType, String overridesJson, Boolean generateNow, List<DL_Request__c> rows) {
        Map<String, Object> form = getJson('/launch-form?contractType=' + EncodingUtil.urlEncode(contractType, 'UTF-8'));
        List<Object> fields = (List<Object>) form.get('fields');
        Map<String, Map<String, Object>> records = DraftLegalRecords.load(recordId, fields);
        DraftLegalRecords.applyOverrides(records, fields, overridesJson);

        User me = [SELECT Email, FederationIdentifier, Name FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];
        Map<String, Object> body = new Map<String, Object>{
            'contractType' => contractType,
            'records' => records,
            'requestedBy' => new Map<String, Object>{
                'email' => me.Email,
                'federationId' => me.FederationIdentifier,
                'name' => me.Name
            },
            'generateNow' => generateNow
        };
        Map<String, Object> created = postJson('/requests', body);

        // A record of the request on the deal, for the related list.
        Map<String, Object> opp = records.get('Opportunity');
        Map<String, Object> acct = records.get('Account');
        rows.add(new DL_Request__c(
            Name = String.valueOf(created.get('requestNumber') != null ? created.get('requestNumber') : created.get('requestId')).left(80),
            DL_Request_Id__c = (String) created.get('requestId'),
            DL_Contract_Type__c = contractType,
            DL_Link__c = (String) created.get('deepLink'),
            DL_Generated_Contract_Id__c = (String) created.get('contractId'),
            DL_Opportunity__c = opp == null ? null : Id.valueOf((String) opp.get('Id')),
            DL_Account__c = acct == null ? null : Id.valueOf((String) acct.get('Id'))
        ));
        return created;
    }

    /** Where a draftLegal contract stands: stages, whose turn, approvals, key terms. */
    @AuraEnabled
    public static Map<String, Object> contractStatus(Id recordId) {
        try {
            return getJson('/contracts/' + EncodingUtil.urlEncode(contractIdFor(recordId), 'UTF-8') + '/status');
        } catch (DraftLegalException e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    /** A link to the read-only document preview, valid for ten minutes. */
    @AuraEnabled
    public static String embedUrl(Id recordId) {
        try {
            Map<String, Object> res = postJson('/embed-token', new Map<String, Object>{ 'contractId' => contractIdFor(recordId) });
            return (String) res.get('url');
        } catch (DraftLegalException e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    /** draftLegal's contract id for a draftLegal Contract record. */
    @TestVisible
    private static String contractIdFor(Id recordId) {
        List<DL_Contract__c> rows = [SELECT DL_Contract_Id__c FROM DL_Contract__c WHERE Id = :recordId WITH USER_MODE LIMIT 1];
        if (rows.isEmpty() || String.isBlank(rows[0].DL_Contract_Id__c)) {
            throw new DraftLegalException('This record is not linked to a draftLegal contract.');
        }
        return rows[0].DL_Contract_Id__c;
    }
}
