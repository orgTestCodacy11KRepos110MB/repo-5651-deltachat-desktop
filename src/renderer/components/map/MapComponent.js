const React = require('react')
const ReactDOMServer = require('react-dom/server')
const ReactDOM = require('react-dom')
const { ipcRenderer } = require('electron')
const debounce = require('debounce')
const mapboxgl = require('mapbox-gl')
const geojsonExtent = require('@mapbox/geojson-extent')
const moment = require('moment/moment')
const formatRelativeTime = require('../conversations/formatRelativeTime')
const MapLayerFactory = require('./MapLayerFactory')
const { Slider, Button, Collapse } = require('@blueprintjs/core/lib/esm/index')
const PopupMessage = require('./PopupMessage')
const SessionStorage = require('../helpers/SessionStorage')
const SettingsContext = require('../../contexts/SettingsContext')

const ContextMenu = require('./ContextMenu')

class MapComponent extends React.Component {
  constructor (props) {
    super(props)
    this.state = {
      timeOffset: 50,
      lastTimeOffset: 50,
      mapStyle: 'default',
      showTerrain: false,
      showControls: false,
      showPathLayer: false,
      currentContacts: []
    }
    this.mapDataStore = new Map()
    this.debounce = debounce(this.renderOrUpdateLayer, 1000)
    this.renderOrUpdateLayer = this.renderOrUpdateLayer.bind(this)
    this.onMapClick = this.onMapClick.bind(this)
    this.onMapRightClick = this.onMapRightClick.bind(this)
    this.sendPoiMessage = this.sendPoiMessage.bind(this)
    this.togglePathLayer = this.togglePathLayer.bind(this)
    this.onRangeChange = this.onRangeChange.bind(this)
    this.changeMapStyle = this.changeMapStyle.bind(this)
    this.toggleTerrainLayer = this.toggleTerrainLayer.bind(this)
    this.renderContactCheckbox = this.renderContactCheckbox.bind(this)
    this.contextMenu = React.createRef()
    this.contextMenuPopup = null
  }

  componentDidMount () {
    this.currentUserAddress = this.context.credentials.addr
    this.componentDidMount = Date.now()
    const { selectedChat } = this.props
    const saveData = SessionStorage.getItem(this.currentUserAddress, `${selectedChat.id}_map`)
    let mapSettings = { zoom: 4, center: [8, 48] } // <- default
    if (saveData !== undefined) {
      const { savedMapSettings, savedState } = saveData
      mapSettings = savedMapSettings
      this.setState(savedState)
      this.stateFromSession = true
    }
    mapboxgl.accessToken = MapLayerFactory.getAccessToken()
    this.map = new mapboxgl.Map(
      {
        container: 'map',
        style: 'mapbox://styles/mapbox/outdoors-v11',
        zoom: mapSettings.zoom,
        center: mapSettings.center,
        attributionControl: false
      }
    )
    this.map.on('load', this.renderOrUpdateLayer)
    this.map.on('click', this.onMapClick)
    this.map.on('contextmenu', this.onMapRightClick)
    this.map.addControl(new mapboxgl.NavigationControl({ showCompass: false }))
  }

  componentWillUnmount () {
    // save parts of the state we wanna keep
    const { selectedChat } = this.props
    SessionStorage.storeItem(this.currentUserAddress, `${selectedChat.id}_map`, {
      savedMapSettings: {
        zoom: this.map.getZoom(),
        center: this.map.getCenter()
      },
      savedState: this.state
    })
  }

  renderOrUpdateLayer () {
    const { selectedChat } = this.props
    const contacts = selectedChat.contacts
    if (this.state.timeOffset < this.state.lastTimeOffset) {
      // remove all layer since source update does not remove existing points
      this.removeAllLayer()
      this.mapDataStore.clear()
    }
    this.renderLayers(selectedChat, contacts)
  }

  async renderLayers (selectedChat, contacts) {
    let allPoints = []
    let currentContacts = []
    let locationsForChat = await ipcRenderer.sendSync('getLocations', selectedChat.id, 0, this.getTimestampForRange(), 0)
    contacts.map(contact => {
      let locationsForContact = locationsForChat.filter(location => location.contactId === contact.id)
      if (locationsForContact && locationsForContact.length) {
        let pointsForLayer = locationsForContact.map(point => [point.longitude, point.latitude])
        // map data to handle map state
        let mapData = {
          contact: contact,
          pathLayerId: 'contact-route-' + contact.id,
          pointsLayerId: 'points-' + contact.id,
          hidden: false
        }
        const existingContact = this.state.currentContacts.find(item => item.id === contact.id)
        if (existingContact) {
          mapData.hidden = existingContact.hidden
        }
        this.mapDataStore.set(contact.id, mapData)
        this.addLayerForContact(mapData, locationsForContact)

        let lastPoint = locationsForContact[0]
        let lastDate = formatRelativeTime(lastPoint.timestamp * 1000, { extended: true })
        let popup = new mapboxgl.Popup({ offset: 25 }).setHTML(this.renderPopupMessage(contact.firstName, lastDate, null))
        if (mapData.marker) {
          // remove old marker
          mapData.marker.remove()
        }
        mapData.marker = new mapboxgl.Marker({ color: '#' + contact.color.toString(16) })
          .setLngLat([lastPoint.longitude, lastPoint.latitude])
          .setPopup(popup)
        if (mapData.hidden) {
          // the contact is hidden so don't show the contact's layers
          this.toggleContactLayer(contact.id, false)
        } else {
          mapData.marker.addTo(this.map)
        }
        // light weight contact object for component state in contact filter control
        currentContacts.push(
          {
            id: contact.id,
            name: contact.firstName,
            hidden: mapData.hidden,
            color: contact.color
          })
        allPoints = allPoints.concat(pointsForLayer)
      }
    })
    this.setState({ currentContacts: currentContacts })
    if (this.stateFromSession) {
      this.stateFromSession = false
      this.setTerrainLayer(this.state.showTerrain)
      this.changeMapStyle(this.state.mapStyle)
    } else {
      if (allPoints.length > 0) {
        this.map.fitBounds(geojsonExtent({ type: 'Point', coordinates: allPoints }), { padding: 100 })
      }
    }
    this.state.lastTimeOffset = this.state.timeOffset
  }

  removeAllLayer () {
    this.mapDataStore.forEach(
      (mapDataItem) => {
        if (this.map.getLayer(mapDataItem.pathLayerId)) {
          this.map.removeLayer(mapDataItem.pathLayerId)
          this.map.removeSource(mapDataItem.pathLayerId)
        }
        if (this.map.getLayer(mapDataItem.pointsLayerId)) {
          this.map.removeLayer(mapDataItem.pointsLayerId)
          this.map.removeSource(mapDataItem.pointsLayerId)
        }
        if (mapDataItem.marker) {
          mapDataItem.marker.remove()
        }
      }
    )
  }

  addLayerForContact (mapData, locationsForContact) {
    if (!this.map.getSource(mapData.pathLayerId)) {
      this.addPathLayer(locationsForContact, mapData)
    } else {
      // update source
      this.map.getSource(mapData.pathLayerId).setData(MapLayerFactory.getGeoJSONLineSourceData(locationsForContact))
    }
    if (!this.map.getSource(mapData.pointsLayerId)) {
      this.addPathJointsLayer(locationsForContact, mapData)
    } else {
      this.map.getSource(mapData.pointsLayerId).setData(MapLayerFactory.getGeoJSONPointsLayerSourceData(locationsForContact, mapData.contact, true))
    }
  }

  addPathLayer (locationsForContact, mapData) {
    let source = { type: 'geojson',
      data: MapLayerFactory.getGeoJSONLineSourceData(locationsForContact)
    }
    this.map.addSource(
      mapData.pathLayerId,
      source
    )
    let layer = MapLayerFactory.getGeoJSONLineLayer(mapData.pathLayerId, mapData.contact.color)
    this.map.addLayer(layer)
    if (!this.state.showPathLayer) {
      this.map.setLayoutProperty(mapData.pathLayerId, 'visibility', 'none')
    }
  }

  addPathJointsLayer (locationsForContact, data) {
    let source = { type: 'geojson',
      data: MapLayerFactory.getGeoJSONPointsLayerSourceData(locationsForContact, data.contact, true)
    }
    this.map.addSource(
      data.pointsLayerId,
      source
    )
    let layer = MapLayerFactory.getGeoJSONPointsLayer(data.pointsLayerId, data.contact.color)
    this.map.addLayer(layer)
  }

  onMapClick (event) {
    console.log('onMapClick', event)
    const { selectedChat } = this.props
    let message
    let features = this.map.queryRenderedFeatures(event.point)
    const contactFeature = features.find(f => {
      return (f.properties.contact !== undefined)
    })
    if (contactFeature) {
      if (contactFeature.properties.msgId) {
        const messageObj = selectedChat.messages.find(msg => msg.id === contactFeature.properties.msgId)
        if (messageObj) {
          message = messageObj.msg
        }
      }
      let markup = this.renderPopupMessage(
        contactFeature.properties.contact,
        formatRelativeTime(contactFeature.properties.reported * 1000, { extended: true }),
        message)
      new mapboxgl.Popup({ offset: [0, -15] })
        .setHTML(markup)
        .setLngLat(contactFeature.geometry.coordinates)
        .addTo(this.map)
    }
  }

  sendPoiMessage (evt) {
    console.log('sendPoiMessage', evt)
    if (this.contextMenuPopup) {
      this.contextMenuPopup.remove()
    }
  }

  onMapRightClick (event) {
    console.log(event)
    console.log(this.contextMenu.current)
    this.contextMenuPopup = new mapboxgl.Popup({ offset: [0, -15] })
      .setLngLat(event.lngLat)
      .setDOMContent(ReactDOM.findDOMNode(this.contextMenu.current))
      .addTo(this.map)
  }

  togglePathLayer () {
    this.setState({ showPathLayer: !this.state.showPathLayer })
    const newVisibility = this.state.showPathLayer ? 'none' : 'visible'
    this.mapDataStore.forEach(
      (mapDataItem) => {
        this.map.setLayoutProperty(mapDataItem.pathLayerId, 'visibility', newVisibility)
        // this.map.setLayoutProperty(mapDataItem.pointsLayerId, 'visibility', newVisibility)
      }
    )
  }

  onRangeChange (value) {
    this.setState({ 'timeOffset': value })
    this.debounce(value)
  }

  changeMapStyle (style) {
    this.setState({ mapStyle: style })
    const visibility = (style === 'satellite') ? 'visible' : 'none'

    if (!this.map.getLayer('satellite')) {
      this.map.addLayer(MapLayerFactory.getSatelliteMapLayer('satellite'))
      // move other layers to top
      this.mapDataStore.forEach(
        (mapDataItem) => {
          if (this.map.getLayer(mapDataItem.pathLayerId)) {
            this.map.moveLayer(mapDataItem.pathLayerId)
          }
          if (this.map.getLayer(mapDataItem.pointsLayerId)) {
            this.map.moveLayer(mapDataItem.pointsLayerId)
          }
        }
      )
    }
    this.map.setLayoutProperty('satellite', 'visibility', visibility)
  }

  toggleTerrainLayer () {
    const showTerrain = !this.state.showTerrain
    this.setState({ showTerrain })
    this.setTerrainLayer(showTerrain)
  }

  setTerrainLayer (showTerrain) {
    const visibility = showTerrain ? 'visible' : 'none'
    console.log(visibility)
    if (this.map.getLayer('terrain')) {
      this.map.setLayoutProperty('terrain', 'visibility', visibility)
    } else {
      this.map.addSource('dem', {
        type: 'raster-dem',
        url: 'mapbox://mapbox.terrain-rgb'
      })
      this.map.addLayer({
        id: 'terrain',
        source: 'dem',
        type: 'hillshade',
        layout: { 'visibility': visibility }
      })
    }
  }

  rangeSliderLabelRenderer (value) {
    const rangeMap = MapLayerFactory.getRangeMap()
    return rangeMap[value].label
  }

  getTimestampForRange () {
    const rangeMap = MapLayerFactory.getRangeMap()
    if (rangeMap[this.state.timeOffset].minutes === 0) {
      return 0
    } else {
      return moment().unix() - rangeMap[this.state.timeOffset].minutes * 60
    }
  }

  toggleContactLayer (contactId, isHidden) {
    let mapDataItem = this.mapDataStore.get(contactId)
    const visibility = isHidden ? 'visible' : 'none'
    if (!isHidden) {
      mapDataItem.marker.remove()
      mapDataItem.hidden = true
    } else {
      mapDataItem.marker.addTo(this.map)
      mapDataItem.hidden = false
    }
    let currentContacts = this.state.currentContacts.map(
      contactItem => contactItem.id === contactId ? { ...contactItem, ...{ hidden: mapDataItem.hidden } } : contactItem)
    this.setState({ currentContacts: currentContacts })
    this.map.setLayoutProperty(mapDataItem.pathLayerId, 'visibility', visibility)
    this.map.setLayoutProperty(mapDataItem.pointsLayerId, 'visibility', visibility)
    if (!this.stateFromSession) {
      this.setBoundToMarker()
    }
  }

  setBoundToMarker () {
    let markerCoordinates = []
    this.mapDataStore.forEach(
      mapDataitem => {
        if (mapDataitem.marker && !mapDataitem.hidden) {
          const lngLat = mapDataitem.marker.getLngLat()
          markerCoordinates.push([lngLat.lng, lngLat.lat])
        }
      }
    )
    if (markerCoordinates.length) {
      this.map.fitBounds(geojsonExtent({ type: 'Point', coordinates: markerCoordinates }), { padding: 100 })
    }
  }

  renderPopupMessage (contactName, formattedDate, message) {
    const i18n = window.translate
    return ReactDOMServer.renderToStaticMarkup(
      <PopupMessage username={contactName} formattedDate={formattedDate} message={message} i18n={i18n} />
    )
  }

  renderContactCheckbox (contact) {
    return (
      <div key={contact.id} >
        <input type='checkbox' name={contact.id} onChange={() => this.toggleContactLayer(contact.id, contact.hidden)} checked={!contact.hidden} />
        <label style={{ color: '#' + contact.color.toString(16) }}>{contact.name} </label>
      </div>
    )
  }

  render () {
    return (
      <div>
        <nav id='controls' className='map-overlay top'>
          <Button minimal className='collapse-control' icon={this.state.showControls ? 'chevron-up' : 'chevron-down'} onClick={() => this.setState({ showControls: !this.state.showControls })}>Map controls</Button>
          <Collapse isOpen={this.state.showControls}>
            <Button minimal className='toggle-path' icon='layout' onClick={this.togglePathLayer} > {this.state.showPathLayer ? 'Hide' : 'Show'} paths </Button>
            <div id='menu' >
              <div>
                <input id='default'
                  type='radio'
                  name='rtoggle'
                  value='default'
                  checked={this.state.mapStyle === 'default'}
                  onChange={() => this.changeMapStyle('default')} />
                <label htmlFor='streets'>Streets</label>
              </div>
              <div>
                <input id='satellite'
                  type='radio'
                  name='rtoggle'
                  value='satellite'
                  checked={this.state.mapStyle === 'satellite'}
                  onChange={() => this.changeMapStyle('satellite')} />
                <label htmlFor='satellite'>Satellite</label>
              </div>
              <div>
                <input id='terrain'
                  type='checkbox'
                  name='rtoggle'
                  value='terrain'
                  checked={this.state.showTerrain}
                  onChange={this.toggleTerrainLayer} />
                <label htmlFor='terrain'>Terrain</label>
              </div>
            </div>
            <h3>Time range</h3>
            <Slider min={10}
              max={90}
              stepSize={10}
              labelStepSize={10}
              labelRenderer={this.rangeSliderLabelRenderer}
              onChange={this.onRangeChange}
              value={this.state.timeOffset}
              vertical='true' />
            <div className='contactFilter'>
              <h3>Hide contacts</h3>
              {this.state.currentContacts.map(this.renderContactCheckbox)}
            </div>
          </Collapse>
        </nav>
        <div id='map' />
        <ContextMenu ref={this.contextMenu} onSetPoi={this.sendPoiMessage} />
      </div>
    )
  }
}
MapComponent.contextType = SettingsContext

module.exports = MapComponent
