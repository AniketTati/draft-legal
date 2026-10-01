/**
 * Flow action "Tell draftLegal a deal changed": call it from a record-triggered
 * Flow on Opportunity (or Quote, Account) update. It sends the record's mapped
 * fields; draftLegal updates the contracts made from it while Salesforce still
 * owns the deal, and once a contract is out for signature or signed it asks the
 * contract's owner instead of changing it.
 *
 * Runs asynchronously (a callout can't run inside the triggering transaction).
 */
global with sharing class DraftLegalChangeAction {
    global class Input {
        @InvocableVariable(required=true label='Record Id' description='The Opportunity, Quote or Account that changed')
        global Id recordId;
    }

    @InvocableMethod(label='Tell draftLegal a deal changed' description='Send the changed record to draftLegal' category='draftLegal')
    global static void notify(List<Input> inputs) {
        List<Id> ids = new List<Id>();
        for (Input input : inputs) {
            ids.add(input.recordId);
        }
        if (!ids.isEmpty()) {
            System.enqueueJob(new Send(ids));
        }
    }

    public class Send implements Queueable, Database.AllowsCallouts {
        private final List<Id> ids;
        public Send(List<Id> ids) { this.ids = ids; }

        public void execute(QueueableContext context) {
            List<Object> fields = (List<Object>) DraftLegalApi.getJson('/launch-form?all=1').get('fields');
            // The org's API allows 100 callouts a transaction; the rest go on.
            Integer budget = Limits.getLimitCallouts() - Limits.getCallouts() - 1;
            List<Id> later = new List<Id>();
            for (Id recordId : ids) {
                if (budget-- <= 0) {
                    later.add(recordId);
                    continue;
                }
                String type = recordId.getSobjectType().getDescribe().getName();
                Map<String, Map<String, Object>> records = DraftLegalRecords.load(recordId, fields);
                Map<String, Object> record = records.remove(type);
                if (record == null) {
                    continue;
                }
                DraftLegalApi.postJson('/changes', new Map<String, Object>{
                    'object' => type,
                    'record' => record,
                    'records' => records
                });
            }
            if (!later.isEmpty() && !Test.isRunningTest()) {
                System.enqueueJob(new Send(later));
            }
        }
    }
}
