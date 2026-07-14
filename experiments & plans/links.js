// For testing custom link parsing


// Variations
// Tag comma escapes

// Command Short forms: 
//  - ta(gs)
//     - array (comma delimited), or false to specify not to include the selected tags
//  - to(pics)
//     - array (comma delimited), or false to specify not to include the selected tags
//  - f(avourite)
//      - true(implicit), false
//  - d(one)
//      - true(implicit), false
//  - r(esources)
//      - true(implicit), false
//  - c(lean)
//      - true (implicit), false
//  - w(eeks)
//      - Can be false, or number. 0 being current week
//
// Data short forms
// 
//  - true, 1, yes
//  - false, 0, no
//
// - [The Untold Story of SSH - YouTube](https://www.youtube.com/watch?v=1UX_iTdrtbc) !tags=[security, history,documentary,webdev] !topics=[history] !week=0 !clean=false
// [Poseidon-fan/linux-0.11-rs](https://github.com/Poseidon-fan/linux-0.11-rs?ref=dailydev) !tags=[linux,os, really\,really\,rusty] !resource !done !favourite


const protocolRE = /(?'protocol'((http|https):\/\/)|\/\/)/
const bulletsRE = /(?:(-|\*|\d+?(\.|\)))\s?+)/ // Match markdown ol or ul
const markdownLinkInfo = /(?'linkInfo'(?'title'\[[^\]]+\])\((?'link'[^)]+)\))/ // e.g. [Mysite](kieranwood.ca?ref="hello")
const markdownLinkRE =  /^(?'linkInfo'(?'title'\[[^\]]+\])\((?'link'[^)]+)\))(?:[ \t]+(?'extras'.*))?$/



// Start of line
// 1.1 space or no space \s*?
// 2.1 bullet (-, *, 1., 2., 3\) )
// 2.2 direct link (http(s)://, //, [title](link))

const testString = `
http://kieranwood.ca
https://kieranwood.ca
//kieranwood.ca
kieranwood.ca?ref="hello"
- http://kieranwood.ca
- https://kieranwood.ca
- //kieranwood.ca
- kieranwood.ca?ref="hello"
-http://kieranwood.ca
-https://kieranwood.ca
-//kieranwood.ca
-kieranwood.ca?ref="hello"
[Mysite](http://kieranwood.ca)
[Mysite](https://kieranwood.ca)
[Mysite](//kieranwood.ca)
[Mysite](kieranwood.ca?ref="hello")
- [Mysite](http://kieranwood.ca)
- [Mysite](https://kieranwood.ca)
- [Mysite](//kieranwood.ca)
- [Mysite](kieranwood.ca?ref="hello")
* http://kieranwood.ca
* https://kieranwood.ca
* //kieranwood.ca
* kieranwood.ca?ref="hello"
*http://kieranwood.ca
*https://kieranwood.ca
*//kieranwood.ca
*kieranwood.ca?ref="hello"
* [Mysite](http://kieranwood.ca)
* [Mysite](https://kieranwood.ca)
* [Mysite](//kieranwood.ca)
* [Mysite](kieranwood.ca?ref="hello")
*[Mysite](http://kieranwood.ca)
*[Mysite](https://kieranwood.ca)
*[Mysite](//kieranwood.ca)
*[Mysite](kieranwood.ca?ref="hello")
1. http://kieranwood.ca
2. https://kieranwood.ca
3. //kieranwood.ca
4. kieranwood.ca?ref="hello"
1.http://kieranwood.ca
1.https://kieranwood.ca
1.//kieranwood.ca
1.kieranwood.ca?ref="hello"
1. [Mysite](http://kieranwood.ca)
2. [Mysite](https://kieranwood.ca)
3. [Mysite](//kieranwood.ca)
4. [Mysite](kieranwood.ca?ref="hello")
1)[Mysite](http://kieranwood.ca)
2)[Mysite](https://kieranwood.ca)
3)[Mysite](//kieranwood.ca)
4)[Mysite](kieranwood.ca?ref="hello")
`

/**
 * 
 * @param {string} remainingText 
 * @returns {boolean} if a valid number list entry or not
 */
function parseNumberList(remainingText){
    const digits = ['0','1','2','3','4','5','6','7','8','9','0']
    for (let i = 0; i < remainingText.length; i++) {
        // First value must be a digit
        if (i == 0 && digits.includes(remainingText[i])) {
            continue
        } else{
            return false
        }

    }
}

function parseLinks(text) {

}
