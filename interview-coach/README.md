# Interview coach

A question every morning at 9 (IST), graded by an LLM. Code: [server/modules/interview.mjs](../server/modules/interview.mjs), page: `/interview`.

- Topics rotate through Java, Spring Boot, SQL, system design, DSA, payments and more.
- Weighted repetition: unanswered and low-scoring topics come back sooner; the last few topics are rested.
- Answer on the hub or by replying to the ntfy `<topic>-iq` topic. You get a 1-5 score, what was good, what was missing, and a model answer.
- Sunday 8 PM recap: answers this week, average, and the two topics to focus on next.
