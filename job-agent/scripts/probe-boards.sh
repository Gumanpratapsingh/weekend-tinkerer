#!/bin/sh
# Prints which ATS board slugs exist and how many of their jobs are in India or remote.
gh="postman phonepe groww inmobi browserstack sprinklr druva hackerrank chargebee clevertap stripe databricks mongodb elastic twilio rubrik confluent okta gitlab coinbase razorpaysoftwareprivatelimited razorpay zomato cred paytm uber airbnb nutanix zscaler toast circleci hashicorp cloudflare samsara anthropic sumologic mindtickle whatfix highradius icertis innovaccer udaan acko slice"
lv="cred meesho zeta dreamsports swiggy upstox jupiter plivo hasura paytm groww sarvam razorpay spotdraft atlan sprinto signeasy leena freshworks smallcase dunzo khatabook bharatpe zepto mpl unacademy"
ab="sarvam composio openai razorpay juspay atlan spotdraft krutrim ema hyperverge rippling plivo setu glean notion postman"
for s in $gh; do n=$(curl -s -m 10 "https://boards-api.greenhouse.io/v1/boards/$s/jobs" | python3 -c "import sys,json
try:
  j=json.load(sys.stdin)['jobs']; print(len(j), sum(1 for x in j if any(k in (x.get('location') or {}).get('name','').lower() for k in ['india','bengaluru','bangalore','chennai','hyderabad','pune','remote','gurugram','mumbai','noida'])))
except Exception: print('-')"); echo "greenhouse $s $n"; done
for s in $lv; do n=$(curl -s -m 10 "https://api.lever.co/v0/postings/$s?mode=json" | python3 -c "import sys,json
try:
  j=json.load(sys.stdin); assert isinstance(j,list); print(len(j), sum(1 for x in j if any(k in (x.get('categories') or {}).get('location','').lower() for k in ['india','bengaluru','bangalore','chennai','hyderabad','pune','remote','gurugram','mumbai','noida'])))
except Exception: print('-')"); echo "lever $s $n"; done
for s in $ab; do n=$(curl -s -m 10 "https://api.ashbyhq.com/posting-api/job-board/$s" | python3 -c "import sys,json
try:
  j=json.load(sys.stdin)['jobs']; print(len(j), sum(1 for x in j if any(k in (x.get('location') or '').lower() for k in ['india','bengaluru','bangalore','chennai','hyderabad','pune','remote','gurugram','mumbai','noida'])))
except Exception: print('-')"); echo "ashby $s $n"; done
