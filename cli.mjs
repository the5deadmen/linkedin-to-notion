#!/usr/bin/env node

import axios from 'axios'
import readline from 'readline'

const QUERY_ID = 'voyagerSearchDashClusters.843215f2a3455f1bed85762a45d71be8'
const PAGE_SIZE = 20

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(r => rl.question(q, r))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function log(msg) { console.log(`\x1b[36m→\x1b[0m ${msg}`) }
function success(msg) { console.log(`\x1b[32m✓\x1b[0m ${msg}`) }
function error(msg) { console.log(`\x1b[31m✗\x1b[0m ${msg}`) }

// --- LinkedIn ---

async function getSession(liAt) {
  const res = await axios.get('https://www.linkedin.com/feed/', {
    headers: {
      cookie: `li_at=${liAt}`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    },
    maxRedirects: 0,
    validateStatus: () => true,
  })

  if (res.headers['clear-site-data']) return null

  const cookies = res.headers['set-cookie'] || []
  const match = cookies.map(c => c.match(/JSESSIONID="?([^";]+)"?/)).find(Boolean)
  return match ? match[1].replace(/"/g, '') : null
}

function createLinkedIn(liAt, jsessionid) {
  return axios.create({
    baseURL: 'https://www.linkedin.com',
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
      'cookie': `li_at=${liAt}; JSESSIONID="${jsessionid}"`,
      'csrf-token': jsessionid,
    },
  })
}

async function fetchSavedPage(client, start, paginationToken) {
  let variables = `(start:${start},count:${PAGE_SIZE},query:(flagshipSearchIntent:SEARCH_MY_ITEMS_SAVED_POSTS,queryParameters:List((key:savedPostType,value:List(ALL)))))`
  if (paginationToken) {
    variables = `(start:${start},count:${PAGE_SIZE},query:(flagshipSearchIntent:SEARCH_MY_ITEMS_SAVED_POSTS,queryParameters:List((key:savedPostType,value:List(ALL)))),paginationToken:${paginationToken})`
  }
  const res = await client.get('/voyager/api/graphql', { params: { queryId: QUERY_ID, variables } })
  return res.data
}

async function fetchPostContent(client, activityUrn) {
  try {
    const res = await client.get(`/voyager/api/feed/updates/${encodeURIComponent(activityUrn)}`)
    const included = res.data?.included || []
    for (const item of included) {
      if (item?.commentary?.text?.text) return item.commentary.text.text
    }
    return null
  } catch { return null }
}

function parseRelativeDate(text) {
  if (!text) return null
  const now = new Date()
  const match = text.match(/(\d+)\s*(h|d|w|mo|yr|j|sem|m|a)/)
  if (!match) return now.toISOString().split('T')[0]
  const [, num, unit] = match
  const n = parseInt(num)
  const offsets = { h: 'Hours', d: 'Date', j: 'Date', w: 'Date', sem: 'Date', mo: 'Month', m: 'Month', yr: 'FullYear', a: 'FullYear' }
  const multipliers = { w: 7, sem: 7 }
  const method = `set${offsets[unit]}`
  const getter = `get${offsets[unit]}`
  now[method](now[getter]() - n * (multipliers[unit] || 1))
  return now.toISOString().split('T')[0]
}

// --- Notion ---

function createNotion(token) {
  return axios.create({
    baseURL: 'https://api.notion.com/v1',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  })
}

async function ensureNotionProperties(notion, dbId) {
  await notion.patch(`/databases/${dbId}`, {
    properties: {
      Auteur: { rich_text: {} },
      Headline: { rich_text: {} },
      URL: { url: {} },
      Date: { date: {} },
    },
  })
}

async function getExistingUrls(notion, dbId) {
  const urls = new Set()
  let cursor = undefined
  do {
    const res = await notion.post(`/databases/${dbId}/query`, { start_cursor: cursor, page_size: 100 })
    for (const page of res.data.results) {
      for (const prop of Object.values(page.properties)) {
        if (prop.type === 'url' && prop.url) urls.add(prop.url)
      }
    }
    cursor = res.data.has_more ? res.data.next_cursor : undefined
  } while (cursor)
  return urls
}

async function pushToNotion(notion, dbId, post) {
  const titleText = `${post.author}: ${(post.summary || '').substring(0, 80)}`
  const properties = {
    Nom: { title: [{ text: { content: titleText } }] },
    Auteur: { rich_text: [{ text: { content: post.author || '' } }] },
    Headline: { rich_text: [{ text: { content: (post.authorHeadline || '').substring(0, 200) } }] },
    URL: { url: post.url || null },
  }
  if (post.date) properties.Date = { date: { start: post.date } }

  const children = []
  const content = post.content || post.summary || ''
  if (content) {
    for (const chunk of content.match(/.{1,2000}/gs) || []) {
      children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: chunk } }] } })
    }
  }

  await notion.post('/pages', { parent: { database_id: dbId }, properties, children })
}

// --- Main ---

async function main() {
  console.log()
  console.log('\x1b[1mLinkedIn → Notion\x1b[0m')
  console.log('Export your saved LinkedIn posts to a Notion database.\n')

  // Step 1: LinkedIn cookie
  console.log('\x1b[1m1. LinkedIn Cookie\x1b[0m')
  console.log('   Open linkedin.com → F12 → Application → Cookies → copy \x1b[33mli_at\x1b[0m value\n')
  const liAt = (await ask('   li_at cookie: ')).trim()

  log('Validating cookie...')
  const jsessionid = await getSession(liAt)
  if (!jsessionid) {
    error('Invalid or expired cookie. Please get a fresh one from your browser.')
    rl.close()
    process.exit(1)
  }
  success('LinkedIn session OK\n')

  // Step 2: Notion
  console.log('\x1b[1m2. Notion Setup\x1b[0m')
  console.log('   Create an integration at notion.so/my-integrations → copy the token')
  console.log('   Then share your database with the integration\n')
  const notionToken = (await ask('   Notion token: ')).trim()
  const dbId = (await ask('   Database ID (from the URL): ')).trim()

  const notion = createNotion(notionToken)

  log('Checking Notion access...')
  try {
    await notion.get(`/databases/${dbId}`)
  } catch (e) {
    if (e.response?.status === 404) {
      error('Database not found. Make sure you shared it with your integration.')
    } else {
      error(`Notion error: ${e.response?.data?.message || e.message}`)
    }
    rl.close()
    process.exit(1)
  }
  success('Notion connected')

  log('Setting up database properties...')
  await ensureNotionProperties(notion, dbId)
  success('Properties ready\n')

  rl.close()

  // Step 3: Fetch
  console.log('\x1b[1m3. Fetching saved posts\x1b[0m')
  const client = createLinkedIn(liAt, jsessionid)

  log('Checking for existing entries...')
  let existingUrls = new Set()
  try { existingUrls = await getExistingUrls(notion, dbId) } catch {}
  if (existingUrls.size) log(`${existingUrls.size} posts already in Notion (will skip)`)

  const allPosts = []
  let start = 0
  let paginationToken = null

  while (true) {
    const data = await fetchSavedPage(client, start, paginationToken)
    const included = data.included || []
    const entities = included.filter(i => i.$type?.includes('EntityResultViewModel'))
    if (entities.length === 0) break

    for (const entity of entities) {
      const url = entity.navigationUrl?.split('?')[0] || ''
      if (existingUrls.has(url)) continue
      allPosts.push({
        author: entity.title?.text || '',
        authorHeadline: entity.primarySubtitle?.text || '',
        summary: entity.summary?.text || '',
        url,
        activityUrn: entity.trackingUrn || '',
        date: parseRelativeDate(entity.secondarySubtitle?.text),
      })
    }

    const metadata = data.data?.data?.searchDashClustersByAll?.metadata
    paginationToken = metadata?.paginationToken ? `"${metadata.paginationToken}"` : null
    const total = metadata?.totalResultCount || 0
    start += PAGE_SIZE
    log(`${Math.min(start, total)}/${total} fetched (${allPosts.length} new)`)
    if (start >= total || entities.length < PAGE_SIZE) break
    await sleep(1500)
  }

  if (allPosts.length === 0) {
    success('No new posts to add!')
    return
  }

  // Step 4: Full content
  console.log(`\n\x1b[1m4. Getting full post content\x1b[0m`)
  for (let i = 0; i < allPosts.length; i++) {
    const post = allPosts[i]
    const content = await fetchPostContent(client, post.activityUrn)
    if (content) post.content = content
    process.stdout.write(`\r   ${i + 1}/${allPosts.length}`)
    await sleep(500)
  }
  console.log()

  // Step 5: Push to Notion
  console.log(`\n\x1b[1m5. Pushing to Notion\x1b[0m`)
  let pushed = 0
  for (const post of allPosts) {
    try {
      await pushToNotion(notion, dbId, post)
      pushed++
      process.stdout.write(`\r   ${pushed}/${allPosts.length}`)
    } catch (e) {
      error(`${post.author}: ${e.response?.data?.message || e.message}`)
    }
    await sleep(300)
  }

  console.log(`\n`)
  success(`${pushed}/${allPosts.length} posts exported to Notion!`)
}

main().catch(e => {
  error(e.message)
  process.exit(1)
})
