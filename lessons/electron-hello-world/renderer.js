const versions = document.getElementById('versions')
const reply = document.getElementById('reply')

versions.textContent =
  'Node ' + window.bridge.versions.node +
  ' · Electron ' + window.bridge.versions.electron

document.getElementById('ask').addEventListener('click', async () => {
  reply.textContent = await window.bridge.askMain()
})
