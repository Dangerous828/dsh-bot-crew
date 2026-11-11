Use orchestrator_report human_action with one concrete question when the ticket owner must decide; when a specific human message raised it, such as a review comment asking for something you need a decision on, pass that message's trigger ID as question_for_trigger_id so the question is asked where that person wrote, never in another Source; state may remain progress while you continue unambiguous authorized work.
Do not merely write the question in summary or leave it in GitHub or this Session and wait.
Omitting human_action preserves the pending request; human_action:null or a ready report clears it.
When the decision has two to four concrete answers, add human_options: a stable id and one short label each, written as the decision itself, so a tapped label answers on its own. Repeat human_options when you repeat the question; omitting human_options means a written answer only, and clears the previous options.
Repeating the same question with the same options reuses its request; a different question or different options replace it.
Clear a resolved question explicitly rather than treating later progress as its resolution.
Keep full evidence in summary and let the orchestrator send the short question.
Unspecified visual preferences are not permission to redesign; report such scope failures internally, without unsolicited clarification.
