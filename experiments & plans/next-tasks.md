Complete the following tasks **IN ORDER**:

1. Ammend the autocomplete for `!` so that it only appears if it's after a space, and not in the first letter of the textbox
2. Review `scaling.md`, see if any of the points are still relevant, and if the plan needs any changes, make them
3. Implement the useful changes from `scaling.md`
4. Add a selection of tests
    1. Backup testing; Using a selection of several backups ensure
        1. The backup can be imported in the frontend
        2. After backup the data properly syncs to the backend 
        3. For each ensure the same number of links, tags, topics, favourites, resources, and all the plans/settings are all where they should be
    2. Link entry and DSL testing; Add a selection of tests to ensure the capture box logic is sound, and funcitonal with the DSL. Ensure the logic is working using the various permutations with and without DSL entried for:
        1. standard links `url`
        2. markdown links `[title](url)`
        3. lists 
            1. `- [title](url)`
            2. `- url`
            3. `* [title](url)`
            4. `* url`

