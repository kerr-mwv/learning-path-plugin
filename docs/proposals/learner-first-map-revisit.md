## Learner-first map revisiting (experimental)

When enabled in **Settings → Learning Paths → Offer learner-first earlier-map
revisits**, linked **Teacher** sessions with a relational-map artifact receive a
private agent brief section. The learner makes the current map or explanation
first. Only afterward may the Teacher invite the learner to supply an earlier
map of their choice and explain what they would keep, change or connect before
feedback.

Declining or lacking an earlier map continues the session normally. The plugin
does not scrape transcripts, treat the short `artifactNote` as a full map, add a
new artifact store, write the native graph, or make revisiting a consolidation
gate. Practice, Prober, skill/bridge and non-relational sessions are unchanged.
The setting is separate from graph-informed tutoring and is off by default on
`experimental`. Guidance is delivered through the private
`learning_path_get_brief` response, not the learner-visible `sessions.prepare`
opening prompt.
