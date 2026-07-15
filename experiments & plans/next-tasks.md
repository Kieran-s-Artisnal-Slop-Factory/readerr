Complete the following tasks **IN ORDER**:

1. In the capture box show a list of `LinkRow`s of the most recently added link(s), directly under the `Add to backlog` area with a `Just Added` header to make it easier to find links, especially when on the page for this week and adding links to future weeks or just the backlog
2. Allow me to mass export my resource lists to mardkdown, txt, csv, JSON, or a zip containing a set of HTML pages that follow the currently set theme. The pages should be:
    1. an index page with a listing of each resource list, and a truncated portion of their description (to 100 chars)
    2. Sub-pages for each resource with an easily searchable list of the links, where each link has a clickable title to go to the URL, or a dropdown (details element) that can be clicked to see the links notes/excerpts, and the full url.
3. In the onboarding add the third option to `Sync from existing server` on the very first page that lets someone onboard with their existing backend instance
4. Allow for deep-linking in the onboarding by specifying query params (e.g. `/onboarding?page=2`)
5. When someone specifies a sync server in the settings, if the server has existing data, and the local environment does, give them options:
    1. Wipe local data and replace with data on server (default if no data is specified locally yet)
    2. Keep local data and wipe server
    3. Download remote data, merge with local data, and push result to server
6. Do a full sync end to end test:
    1. Setup a new backend instance with no existing DB
    2. Go through the readerr UI on a fresh frontend instance with no data, and seed some
    3. Setup sync and push the data to the backend
    4. clear the local data
    5. select the new `Sync from existing server` onboarding option, and specify the backend
    6. confirm the latest data is there
    7. clear the data again
    8. Go to `start from scratch`, then navigate to settings and put in the server URL
    9. End to end test options we added in task 5
7. Write full sync user documentation explaining all the features and put it in `/docs/sync.md`
