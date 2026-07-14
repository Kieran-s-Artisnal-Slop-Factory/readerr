Do these tasks in order

1. If I add an existing url 
	1. For the tags, and topics append them to the existing entry (if not already in the list)
	2. If the new one is set to favourite, make the existing link a favourite, if new one is not, but it's already favourite, change nothing
	3. If resource is specified, make sure the exsisting one is set as a resource
	4. If it's a week that's not already set as it's read week or review week, then add it to the review week
2. In `Plans > Automation` my defaults and scheduled plans are not saving properly
3. Add an option in settings to configure whether tags should be sorted alphabetically or by last usage per-page in the capture system (tag chips in the capture box)
4. When the sync system is enabled, under the settings page have an accordion (using `<details>`) that gives you the history of push/pulls (paginated to 30 events)
	1. Allow for a few customization options
		1. Specify if errors should be tracked with three options
			1. Track all errors
			2. Track only explicit errors (e.g. ignore errors when device is offline)
			3. Do not track errors
		2. How long to keep logs for
			1. Default to 30 days
		3. Whether to track successful uploads (warn this will use a lot of storage)
			1. By default leave this off
	2. Show a stat tracker that tells you how many errors, successful pushes, and last-time synced
5. Under the stats page 
	1. Show a storage usage description that shows how much data is stored in your browser/on server
	2. Show historical information
		1. When you first setup the instance
		2. longest daily streak of adding links
		3. Largest number of URL's bulk uploaded
		4. A weekly/monthly/yearly/lifetime average for numbers of
			1. Links read
			2. Favourites 
			3. Resources
			4. Topics created

			
		