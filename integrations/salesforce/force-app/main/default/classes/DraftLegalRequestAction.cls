/**
 * Flow action "Create draftLegal request": start a contract request from an
 * Opportunity, Quote or Account, pre-filled through draftLegal's field map.
 * Use it in a screen Flow or a record-triggered Flow (for example when an
 * Opportunity reaches "Contracting").
 */
global with sharing class DraftLegalRequestAction {
    global class Input {
        @InvocableVariable(required=true label='Record Id' description='The Opportunity, Quote or Account')
        global Id recordId;
        @InvocableVariable(required=true label='Contract type' description='e.g. NDA, MSA, ORDER_FORM')
        global String contractType;
        @InvocableVariable(label='Generate now' description='Draft it at once when the type is self-serve in draftLegal')
        global Boolean generateNow;
    }

    global class Output {
        @InvocableVariable(label='Request id')
        global String requestId;
        @InvocableVariable(label='Request number')
        global String requestNumber;
        @InvocableVariable(label='Link to the request')
        global String deepLink;
        @InvocableVariable(label='Generated contract id')
        global String contractId;
        @InvocableVariable(label='Message' description='Why the contract was not generated, or an error')
        global String message;
    }

    @InvocableMethod(label='Create draftLegal request' description='Send a contract request to draftLegal from a deal' callout=true category='draftLegal')
    global static List<Output> create(List<Input> inputs) {
        List<Output> outputs = new List<Output>();
        List<DL_Request__c> rows = new List<DL_Request__c>();
        for (Input input : inputs) {
            Output out = new Output();
            try {
                Map<String, Object> res = DraftLegalApi.request(input.recordId, input.contractType, null, input.generateNow == true, rows);
                out.requestId = (String) res.get('requestId');
                out.requestNumber = (String) res.get('requestNumber');
                out.deepLink = (String) res.get('deepLink');
                out.contractId = (String) res.get('contractId');
                out.message = (String) res.get('generateRefused');
            } catch (Exception e) {
                out.message = e.getMessage();
            }
            outputs.add(out);
        }
        // After every callout (see DraftLegalApi.request).
        upsert rows DL_Request_Id__c;
        return outputs;
    }
}
